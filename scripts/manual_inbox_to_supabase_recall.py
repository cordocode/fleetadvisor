import os
import json
import csv
import re
import base64
import time
from datetime import datetime
from dateutil import parser
from google.oauth2 import service_account
from googleapiclient.discovery import build
import PyPDF2
from PyPDF2 import PdfMerger
import pdfplumber
from io import BytesIO
from dotenv import load_dotenv
from supabase import create_client, Client
import openai

# Load environment variables
load_dotenv()

# ============================================
## CONFIGURATION
# ============================================
SERVICE_ACCOUNT_FILE = 'donotreply-email-36e9858ffa33.json'
EMAIL_ADDRESS = 'donotreply@gofleetadvisor.com'
LOG_FILE = './processing_log_detailed.csv'

# CONSERVATIVE RATE LIMITING
DELAY_BETWEEN_EMAILS = 3
BATCH_SIZE = 20
BATCH_DELAY = 30

# Supabase
SUPABASE_URL = os.environ.get('NEXT_PUBLIC_SUPABASE_URL')
SUPABASE_KEY = os.environ.get('SUPABASE_SERVICE_ROLE_KEY')
OPENAI_API_KEY = os.environ.get('OPENAI_API_KEY')

if not SUPABASE_URL or not SUPABASE_KEY or not OPENAI_API_KEY:
    print("ERROR: Missing environment variables")
    exit(1)

supabase: Client = create_client(SUPABASE_URL, SUPABASE_KEY)
openai.api_key = OPENAI_API_KEY

class FleetEmailProcessor:
    def __init__(self):
        self.service = self._init_gmail_service()
        self._init_logger()
        self.processed_count = 0
        self.failed_count = 0
        self.skipped_count = 0
        
        self.valid_companies = self._load_valid_companies_from_supabase()
        self.sorted_label_id = self._get_or_create_label('Batch_2_sorted')
        self.processed_message_ids = self._load_processed_message_ids()
    
    def _load_processed_message_ids(self):
        """Load message IDs that have already been successfully processed"""
        processed_ids = set()
        
        if not os.path.exists(LOG_FILE):
            return processed_ids
        
        try:
            with open(LOG_FILE, 'r', encoding='utf-8') as f:
                reader = csv.DictReader(f)
                for row in reader:
                    if row.get('status') == 'success' and row.get('moved_to_sorted') == 'true':
                        processed_ids.add(row['message_id'])
            
            return processed_ids
            
        except Exception as e:
            return processed_ids
    
    def _load_valid_companies_from_supabase(self):
        """Load valid company names from Supabase companies table"""
        valid_companies = {}
        try:
            response = supabase.table('companies').select('name').execute()
            
            if response.data:
                for company in response.data:
                    company_name = company['name']
                    valid_companies[company_name] = company_name
            
            return valid_companies
            
        except Exception as e:
            print(f"ERROR loading companies from Supabase: {e}")
            exit(1)
    
    def _get_or_create_label(self, label_name):
        """Get label ID or create it if it doesn't exist"""
        try:
            results = self.service.users().labels().list(userId='me').execute()
            labels = results.get('labels', [])
            
            for label in labels:
                if label['name'] == label_name:
                    return label['id']
            
            label_object = {
                'name': label_name,
                'labelListVisibility': 'labelShow',
                'messageListVisibility': 'show'
            }
            
            created_label = self.service.users().labels().create(
                userId='me',
                body=label_object
            ).execute()
            
            return created_label['id']
            
        except Exception as e:
            return None
    
    def move_to_sorted_label(self, message_id):
        """Move email to Batch_2_sorted label and remove from INBOX"""
        if not self.sorted_label_id:
            return False
        
        try:
            self.service.users().messages().modify(
                userId='me',
                id=message_id,
                body={
                    'addLabelIds': [self.sorted_label_id],
                    'removeLabelIds': ['INBOX']
                }
            ).execute()
            
            return True
            
        except Exception as e:
            return False
    
    def _init_gmail_service(self):
        """Initialize Gmail API service with domain-wide delegation"""
        SCOPES = ['https://www.googleapis.com/auth/gmail.readonly', 
                  'https://www.googleapis.com/auth/gmail.modify']
        
        credentials = service_account.Credentials.from_service_account_file(
            SERVICE_ACCOUNT_FILE,
            scopes=SCOPES
        )
        
        delegated_credentials = credentials.with_subject(EMAIL_ADDRESS)
        return build('gmail', 'v1', credentials=delegated_credentials)
    
    def _init_logger(self):
        """Initialize detailed CSV logger"""
        if not os.path.exists(LOG_FILE):
            with open(LOG_FILE, 'w', newline='', encoding='utf-8') as f:
                writer = csv.writer(f)
                writer.writerow([
                    'timestamp',
                    'message_id',
                    'subject',
                    'email_date',
                    'stage',
                    'company',
                    'invoice_filename',
                    'dot_filename',
                    'invoice_uploaded',
                    'dot_uploaded',
                    'moved_to_sorted',
                    'status',
                    'error'
                ])
    
    def log_processing(self, message_id, subject, email_date, stage, company='', 
                      invoice_file='', dot_file='', invoice_uploaded=False, 
                      dot_uploaded='N/A', moved_to_sorted=False, status='processing', error=''):
        """Log detailed processing state"""
        with open(LOG_FILE, 'a', newline='', encoding='utf-8') as f:
            writer = csv.writer(f)
            writer.writerow([
                datetime.now().isoformat(),
                message_id,
                subject[:100],
                email_date,
                stage,
                company,
                invoice_file,
                dot_file,
                str(invoice_uploaded).lower(),
                str(dot_uploaded).lower() if dot_uploaded != 'N/A' else 'N/A',
                str(moved_to_sorted).lower(),
                status,
                error[:200] if error else ''
            ])
    
    def should_process_email(self, message):
        """Check if email meets all criteria for processing"""
        try:
            headers = message['payload'].get('headers', [])
            
            subject = next((h['value'] for h in headers if h['name'] == 'Subject'), '')
            if subject.startswith('Re:'):
                return False
            
            thread_id = message.get('threadId', '')
            message_id = message.get('id', '')
            if thread_id != message_id:
                return False
            
            from_header = next((h['value'] for h in headers if h['name'] == 'From'), '')
            if not '@gofleetadvisor.com' in from_header:
                return False
            
            has_invoice = False
            if 'parts' in message['payload']:
                for part in message['payload']['parts']:
                    filename = part.get('filename', '').lower()
                    if filename.startswith('invoice') and filename.endswith('.pdf'):
                        has_invoice = True
                        break
                    if 'parts' in part:
                        for subpart in part['parts']:
                            filename = subpart.get('filename', '').lower()
                            if filename.startswith('invoice') and filename.endswith('.pdf'):
                                has_invoice = True
                                break
            
            if not has_invoice:
                return False
            
            return True
            
        except Exception as e:
            return False
    
    def get_email_date(self, message):
        """Extract email received date and format as MMDDYYYY"""
        headers = message['payload'].get('headers', [])
        date_str = next((h['value'] for h in headers if h['name'] == 'Date'), None)
        
        if date_str:
            try:
                email_date = parser.parse(date_str)
                return email_date.strftime('%m%d%Y')
            except:
                pass
        
        return datetime.now().strftime('%m%d%Y')
    
    def extract_company_name(self, message):
        """Extract company name using Zapier logic: take first line, remove trailing comma, format"""
        try:
            plain_text = self._get_email_body(message, 'plain')
            company_name = ''
            
            if plain_text:
                text_lines = plain_text.split('\n')
                if len(text_lines) > 0:
                    first_line = text_lines[0].strip()
                    # Remove trailing comma but DON'T strip after (preserve trailing space)
                    if first_line.endswith(','):
                        company_name = first_line[:-1]  # Keep the trailing space!
                    else:
                        company_name = first_line
            
            # Fallback to HTML
            if not company_name:
                html_text = self._get_email_body(message, 'html')
                if html_text:
                    match = re.search(r'<span[^>]*>([^<]+)</span>', html_text)
                    if match:
                        company_name = match.group(1)
                        company_name = re.sub(r'<[^>]*>', '', company_name)
                        company_name = company_name.replace('&amp;', '&')
                        company_name = company_name.replace('&nbsp;', ' ')
                        company_name = company_name.strip()
                        # Remove trailing comma but DON'T strip after
                        if company_name.endswith(','):
                            company_name = company_name[:-1]
            
            # Format using exact Zapier logic: lowercase and replace spaces with hyphens
            if company_name:
                company_formatted = company_name.lower().replace(' ', '-')
                
                if company_formatted in self.valid_companies:
                    return company_formatted
                else:
                    return None
            
            return None
            
        except Exception as e:
            return None
    
    def _get_email_body(self, message, body_type='plain'):
        """Extract email body"""
        try:
            if 'parts' in message['payload']:
                for part in message['payload']['parts']:
                    if part['mimeType'] == f'text/{body_type}':
                        if 'data' in part['body']:
                            return base64.urlsafe_b64decode(part['body']['data']).decode('utf-8')
            elif message['payload']['mimeType'] == f'text/{body_type}':
                if 'data' in message['payload']['body']:
                    return base64.urlsafe_b64decode(message['payload']['body']['data']).decode('utf-8')
        except:
            pass
        return None
    
    def get_attachments(self, message):
        """Get all PDF attachments from email"""
        attachments = []
        
        def process_part(part):
            if part.get('filename', '').lower().endswith('.pdf'):
                if 'attachmentId' in part['body']:
                    att_id = part['body']['attachmentId']
                    att = self.service.users().messages().attachments().get(
                        userId='me',
                        messageId=message['id'],
                        id=att_id
                    ).execute()
                    
                    data = base64.urlsafe_b64decode(att['data'])
                    attachments.append({
                        'filename': part['filename'],
                        'data': data
                    })
        
        if 'parts' in message['payload']:
            for part in message['payload']['parts']:
                process_part(part)
                if 'parts' in part:
                    for subpart in part['parts']:
                        process_part(subpart)
        
        return attachments
    
    def extract_invoice_number(self, attachments):
        """Extract invoice number from attachment filenames"""
        for att in attachments:
            filename = att['filename'].lower()
            if filename.startswith('invoice'):
                match = re.search(r'invoice[-_\s]*(\d+)', filename, re.IGNORECASE)
                if match:
                    return match.group(1)
        return 'NA'
    
    def extract_metadata_from_pdf(self, pdf_data):
        """Use OpenAI to extract unit, VIN, and plate from PDF"""
        try:
            pdf_file = BytesIO(pdf_data)
            text = ""
            
            with pdfplumber.open(pdf_file) as pdf:
                for page in pdf.pages:
                    page_text = page.extract_text()
                    if page_text:
                        text += page_text + "\n"
            
            response = openai.chat.completions.create(
                model="gpt-3.5-turbo",
                messages=[
                    {
                        "role": "system",
                        "content": """Extract vehicle information from invoice text. Return JSON with exactly these keys:
                        - unit: The unit number (uppercase, no spaces) or "NA" if not found
                        - vin: The VIN number (17 characters, uppercase, no spaces) or "NA" if not found
                        - plate: The plate/license number (uppercase, no spaces) or "NA" if not found
                        
                        Remove all whitespace and convert to uppercase. Return ONLY valid JSON."""
                    },
                    {
                        "role": "user",
                        "content": text
                    }
                ],
                temperature=0,
                response_format={"type": "json_object"}
            )
            
            metadata = json.loads(response.choices[0].message.content)
            
            unit = (metadata.get('unit', 'NA') or 'NA').upper().replace(' ', '').strip()
            vin = (metadata.get('vin', 'NA') or 'NA').upper().replace(' ', '').strip()
            plate = (metadata.get('plate', 'NA') or 'NA').upper().replace(' ', '').strip()
            
            if (unit == 'NA' or unit == '') and vin != 'NA' and len(vin) >= 8:
                unit = vin[-8:]
            
            return {
                'unit': unit,
                'vin': vin,
                'plate': plate
            }
            
        except Exception as e:
            return {'unit': 'NA', 'vin': 'NA', 'plate': 'NA'}
    
    def merge_pdfs(self, pdf_list):
        """Merge multiple PDFs into one"""
        merger = PdfMerger()
        for pdf_data in pdf_list:
            merger.append(BytesIO(pdf_data))
        
        output = BytesIO()
        merger.write(output)
        merger.close()
        
        output.seek(0)
        return output.read()
    
    def upload_to_supabase(self, file_data, filename, bucket):
        """Upload file to Supabase storage bucket"""
        try:
            filename = filename.strip()
            
            existing = supabase.storage.from_(bucket).list(path='', options={'search': filename})
            
            if existing and len(existing) > 0:
                return True
            
            supabase.storage.from_(bucket).upload(
                filename,
                file_data,
                file_options={'content-type': 'application/pdf', 'upsert': False}
            )
            
            return True
            
        except Exception as e:
            return False
    
    def process_single_email(self, message):
        """Process a single email message with comprehensive logging"""
        headers = message['payload'].get('headers', [])
        subject = next((h['value'] for h in headers if h['name'] == 'Subject'), 'No Subject')
        message_id = message['id']
        
        print(f"\n{subject}")
        
        email_date = ''
        company = ''
        invoice_filename = ''
        dot_filename = ''
        invoice_uploaded = False
        dot_uploaded = 'N/A'
        moved_to_sorted = False
        
        try:
            email_date = self.get_email_date(message)
            self.log_processing(message_id, subject, email_date, 'date_extracted')
            
            company = self.extract_company_name(message)
            if not company:
                error_msg = "Company name not found or not in Supabase"
                self.log_processing(message_id, subject, email_date, 'company_validation_failed', 
                                  status='failed', error=error_msg)
                self.failed_count += 1
                return
            
            self.log_processing(message_id, subject, email_date, 'company_validated', company=company)
            
            attachments = self.get_attachments(message)
            if not attachments:
                error_msg = "No PDF attachments found"
                self.log_processing(message_id, subject, email_date, 'no_attachments', 
                                  company=company, status='failed', error=error_msg)
                self.failed_count += 1
                return
            
            self.log_processing(message_id, subject, email_date, 'attachments_downloaded', company=company)
            
            invoice_number = self.extract_invoice_number(attachments)
            
            invoice_attachment = None
            dot_attachments = []
            
            for att in attachments:
                filename_lower = att['filename'].lower()
                if filename_lower.startswith('invoice'):
                    invoice_attachment = att
                else:
                    if filename_lower.endswith('.pdf'):
                        dot_attachments.append(att)
            
            if not invoice_attachment:
                error_msg = "No invoice file found"
                self.log_processing(message_id, subject, email_date, 'no_invoice', 
                                  company=company, status='failed', error=error_msg)
                self.failed_count += 1
                return
            
            invoice_metadata = self.extract_metadata_from_pdf(invoice_attachment['data'])
            unit = invoice_metadata['unit']
            vin = invoice_metadata['vin']
            plate = invoice_metadata['plate']
            
            self.log_processing(message_id, subject, email_date, 'metadata_extracted', company=company)
            
            if dot_attachments:
                invoice_filename = f"{company}__I-{invoice_number}__U-{unit}__V-{vin}__D-{email_date}__P-{plate}.pdf".strip()
                dot_filename = f"{company}__dot__I-{invoice_number}__U-{unit}__V-{vin}__D-{email_date}__P-{plate}.pdf".strip()
                
                invoice_uploaded = self.upload_to_supabase(invoice_attachment['data'], invoice_filename, 'INVOICE')
                print(f"  INVOICE: {invoice_filename}")
                
                self.log_processing(message_id, subject, email_date, 'invoice_upload_attempted', 
                                  company=company, invoice_file=invoice_filename, 
                                  invoice_uploaded=invoice_uploaded)
                
                dot_pdfs = [att['data'] for att in dot_attachments]
                merged_dot = self.merge_pdfs(dot_pdfs)
                dot_uploaded = self.upload_to_supabase(merged_dot, dot_filename, 'DOT')
                print(f"  DOT: {dot_filename}")
                
                self.log_processing(message_id, subject, email_date, 'dot_upload_attempted', 
                                  company=company, invoice_file=invoice_filename, 
                                  dot_file=dot_filename, invoice_uploaded=invoice_uploaded, 
                                  dot_uploaded=dot_uploaded)
                
            else:
                invoice_filename = f"{company}__I-{invoice_number}__U-{unit}__V-{vin}__D-{email_date}__P-{plate}.pdf".strip()
                
                invoice_uploaded = self.upload_to_supabase(invoice_attachment['data'], invoice_filename, 'INVOICE')
                print(f"  INVOICE: {invoice_filename}")
                
                self.log_processing(message_id, subject, email_date, 'invoice_upload_attempted', 
                                  company=company, invoice_file=invoice_filename, 
                                  invoice_uploaded=invoice_uploaded)
            
            moved_to_sorted = self.move_to_sorted_label(message_id)
            
            self.log_processing(message_id, subject, email_date, 'completed', 
                              company=company, invoice_file=invoice_filename, 
                              dot_file=dot_filename or 'N/A', 
                              invoice_uploaded=invoice_uploaded, 
                              dot_uploaded=dot_uploaded, 
                              moved_to_sorted=moved_to_sorted, 
                              status='success')
            
            self.processed_count += 1
            
        except Exception as e:
            error_msg = str(e)
            self.log_processing(message_id, subject, email_date or '', 'error', 
                              company=company, invoice_file=invoice_filename, 
                              dot_file=dot_filename or 'N/A', 
                              invoice_uploaded=invoice_uploaded, 
                              dot_uploaded=dot_uploaded, 
                              moved_to_sorted=moved_to_sorted, 
                              status='failed', error=error_msg)
            self.failed_count += 1
    
    def process_inbox(self, limit=None):
        """Process all emails in inbox with aggressive rate limiting"""
        print("FLEET EMAIL PROCESSOR")
        print("="*60)
        
        all_messages = []
        page_token = None
        
        while True:
            results = self.service.users().messages().list(
                userId='me',
                labelIds=['INBOX'],
                pageToken=page_token,
                maxResults=100
            ).execute()
            
            messages = results.get('messages', [])
            all_messages.extend(messages)
            
            page_token = results.get('nextPageToken')
            if not page_token:
                break
        
        total = len(all_messages)
        if limit:
            all_messages = all_messages[:limit]
        
        print(f"Total emails in inbox: {total}")
        print(f"Already processed: {len(self.processed_message_ids)}")
        print(f"Will process: {len(all_messages)}")
        print("="*60)
        
        for idx, msg in enumerate(all_messages, 1):
            msg_id = msg['id']
            
            if msg_id in self.processed_message_ids:
                self.skipped_count += 1
                continue
            
            print(f"[{idx}/{len(all_messages)}]", end=" ")
            
            try:
                message = self.service.users().messages().get(
                    userId='me',
                    id=msg_id
                ).execute()
                
                if not self.should_process_email(message):
                    self.skipped_count += 1
                    continue
                
                self.process_single_email(message)
                
                if idx < len(all_messages):
                    if idx % BATCH_SIZE == 0:
                        time.sleep(BATCH_DELAY)
                    else:
                        time.sleep(DELAY_BETWEEN_EMAILS)
                
            except Exception as e:
                self.failed_count += 1
        
        print("\n" + "="*60)
        print("COMPLETE")
        print(f"Processed: {self.processed_count}")
        print(f"Skipped: {self.skipped_count}")
        print(f"Failed: {self.failed_count}")
        print("="*60)

if __name__ == "__main__":
    processor = FleetEmailProcessor()
    processor.process_inbox(limit=None)