import os
import json
import csv
import re
import base64
import time
from datetime import datetime
from dateutil import parser
from pathlib import Path
from google.oauth2 import service_account
from googleapiclient.discovery import build
import PyPDF2
from PyPDF2 import PdfMerger
import pdfplumber
from io import BytesIO
from dotenv import load_dotenv
from supabase import create_client, Client
import openai

# Load environment variables from parent directory (root of project)
root_dir = Path(__file__).parent.parent
env_path = root_dir / '.env.local'
load_dotenv(env_path)

# ============================================
## CONFIGURATION
# ============================================
EMAIL_ADDRESS = 'donotreply@gofleetadvisor.com'

# Read service accounts from environment variables (JSON strings)
GMAIL_SERVICE_ACCOUNT_JSON = os.environ.get('GOOGLE_SERVICE_ACCOUNT_GMAIL')
SHEETS_SERVICE_ACCOUNT_JSON = os.environ.get('GOOGLE_SERVICE_ACCOUNT_SHEETS')

# Use Google Sheets instead of CSV
SPREADSHEET_ID = os.environ.get('GOOGLE_SHEET_ID')  # Should be the invoice logging sheet

# CONSERVATIVE RATE LIMITING
DELAY_BETWEEN_EMAILS = 3
BATCH_SIZE = 20
BATCH_DELAY = 30

# Supabase
SUPABASE_URL = os.environ.get('NEXT_PUBLIC_SUPABASE_URL')
SUPABASE_KEY = os.environ.get('SUPABASE_SERVICE_ROLE_KEY')
OPENAI_API_KEY = os.environ.get('OPENAI_API_KEY')

if not all([SUPABASE_URL, SUPABASE_KEY, OPENAI_API_KEY, SPREADSHEET_ID, GMAIL_SERVICE_ACCOUNT_JSON]):
    print("ERROR: Missing required environment variables")
    print("Required: NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, OPENAI_API_KEY, GOOGLE_SHEET_ID, GOOGLE_SERVICE_ACCOUNT_GMAIL")
    exit(1)

supabase: Client = create_client(SUPABASE_URL, SUPABASE_KEY)
openai.api_key = OPENAI_API_KEY

class FleetEmailProcessor:
    def __init__(self):
        self.gmail_service = self._init_gmail_service()
        self.sheets_service = self._init_sheets_service()
        self.processed_count = 0
        self.failed_count = 0
        self.skipped_count = 0
        self.cleaned_count = 0  # Track cleanup actions
        
        self.valid_companies = self._load_valid_companies_from_supabase()
        self.sorted_label_id = self._get_or_create_label('Batch_2_sorted')
        self.other_label_id = self._get_or_create_label('Other')
        self.batch_labels = self._get_batch_labels()
        
        # Load existing sheet data
        self.sheet_data = self._load_sheet_data()
        self.message_id_to_row = self._build_message_id_map()
    
    def _init_sheets_service(self):
        """Initialize Google Sheets API service"""
        SCOPES = ['https://www.googleapis.com/auth/spreadsheets']
        
        # Try to use SHEETS service account if available, otherwise fall back to GMAIL
        if SHEETS_SERVICE_ACCOUNT_JSON:
            service_account_info = json.loads(SHEETS_SERVICE_ACCOUNT_JSON)
        else:
            # Fallback to Gmail service account
            service_account_info = json.loads(GMAIL_SERVICE_ACCOUNT_JSON)
        
        credentials = service_account.Credentials.from_service_account_info(
            service_account_info,
            scopes=SCOPES
        )
        
        return build('sheets', 'v4', credentials=credentials)
    
    def _load_sheet_data(self):
        """Load all existing data from the Google Sheet"""
        try:
            result = self.sheets_service.spreadsheets().values().get(
                spreadsheetId=SPREADSHEET_ID,
                range='A:H'
            ).execute()
            
            values = result.get('values', [])
            print(f"Loaded {len(values)} rows from Google Sheet")
            return values
            
        except Exception as e:
            print(f"ERROR loading sheet data: {e}")
            return [['Timestamp', 'Message ID', 'Subject', 'Company', 'Invoice File', 'DOT File', 'Status', 'Error']]
    
    def _build_message_id_map(self):
        """Build map of message_id -> row_number for quick lookups"""
        message_map = {}
        
        # Skip header row (index 0)
        for idx, row in enumerate(self.sheet_data[1:], start=2):  # Start at row 2 (1-indexed)
            if len(row) >= 2:
                message_id = row[1]  # Column B
                if message_id:
                    message_map[message_id] = idx
        
        print(f"Mapped {len(message_map)} message IDs to sheet rows")
        return message_map
    
    def _is_already_processed(self, message_id):
        """Check if message was already successfully processed"""
        if message_id not in self.message_id_to_row:
            return False
        
        row_idx = self.message_id_to_row[message_id]
        row = self.sheet_data[row_idx - 1]  # Convert to 0-indexed
        
        # Check if status is 'success'
        if len(row) >= 7:
            status = row[6]  # Column G (Status)
            return status == 'success'
        
        return False
    
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
            results = self.gmail_service.users().labels().list(userId='me').execute()
            labels = results.get('labels', [])
            
            for label in labels:
                if label['name'] == label_name:
                    return label['id']
            
            label_object = {
                'name': label_name,
                'labelListVisibility': 'labelShow',
                'messageListVisibility': 'show'
            }
            
            created_label = self.gmail_service.users().labels().create(
                userId='me',
                body=label_object
            ).execute()
            
            return created_label['id']
            
        except Exception as e:
            return None
    
    def _get_batch_labels(self):
        """Get all Batch_X_sorted label IDs"""
        batch_labels = {}
        try:
            results = self.gmail_service.users().labels().list(userId='me').execute()
            labels = results.get('labels', [])
            
            for label in labels:
                label_name = label['name']
                # Match Batch_2_sorted, Batch_3_sorted, Batch_4_sorted, etc.
                if label_name.startswith('Batch_') and label_name.endswith('_sorted'):
                    label_id = label['id']
                    batch_labels[label_id] = label_name
            
            print(f"Found {len(batch_labels)} batch labels: {list(batch_labels.values())}")
            return batch_labels
            
        except Exception as e:
            print(f"Error loading batch labels: {e}")
            return {}
    
    def move_to_sorted_label(self, message_id):
        """Move email to Batch_2_sorted label and remove from INBOX"""
        if not self.sorted_label_id:
            return False
        
        try:
            self.gmail_service.users().messages().modify(
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
    
    def move_reply_to_original_label(self, message_id, current_labels):
        """Move reply email back to its original Batch_X_sorted label, or just remove from INBOX"""
        # Find existing batch label
        batch_label_id = None
        batch_label_name = None
        
        for label_id in current_labels:
            if label_id in self.batch_labels:
                batch_label_id = label_id
                batch_label_name = self.batch_labels[label_id]
                break
        
        try:
            if batch_label_id:
                # Has batch label - just remove from INBOX
                self.gmail_service.users().messages().modify(
                    userId='me',
                    id=message_id,
                    body={
                        'removeLabelIds': ['INBOX']
                    }
                ).execute()
                
                print(f"  🔙 Kept in {batch_label_name}, removed from INBOX")
                return True, f"Kept in {batch_label_name}"
            else:
                # No batch label - this is a new reply, just remove from INBOX
                self.gmail_service.users().messages().modify(
                    userId='me',
                    id=message_id,
                    body={
                        'removeLabelIds': ['INBOX']
                    }
                ).execute()
                
                print(f"  🗑️  Reply removed from INBOX")
                return True, "Reply removed from INBOX"
            
        except Exception as e:
            print(f"  ✗ Error moving: {e}")
            return False, str(e)
    
    def move_to_other_label(self, message_id):
        """Move non-invoice email to Other label and remove from INBOX"""
        if not self.other_label_id:
            return False
        
        try:
            self.gmail_service.users().messages().modify(
                userId='me',
                id=message_id,
                body={
                    'addLabelIds': [self.other_label_id],
                    'removeLabelIds': ['INBOX']
                }
            ).execute()
            
            print(f"  📁 Moved to Other label")
            return True
            
        except Exception as e:
            print(f"  ✗ Error moving to Other: {e}")
            return False
    
    def _init_gmail_service(self):
        """Initialize Gmail API service with domain-wide delegation"""
        SCOPES = ['https://www.googleapis.com/auth/gmail.readonly', 
                  'https://www.googleapis.com/auth/gmail.modify']
        
        # Parse service account JSON from environment variable
        service_account_info = json.loads(GMAIL_SERVICE_ACCOUNT_JSON)
        
        credentials = service_account.Credentials.from_service_account_info(
            service_account_info,
            scopes=SCOPES
        )
        
        delegated_credentials = credentials.with_subject(EMAIL_ADDRESS)
        return build('gmail', 'v1', credentials=delegated_credentials)
    
    def log_to_sheet(self, message_id, subject, company='', invoice_file='', 
                     dot_file='', status='processing', error=''):
        """Update Google Sheet - either update existing row or append new row"""
        timestamp = datetime.now().isoformat()
        
        values = [[
            timestamp,
            message_id,
            subject[:100],
            company,
            invoice_file,
            dot_file or 'N/A',
            status,
            error[:200] if error else ''
        ]]
        
        try:
            if message_id in self.message_id_to_row:
                # UPDATE existing row
                row_number = self.message_id_to_row[message_id]
                range_name = f'A{row_number}:H{row_number}'
                
                self.sheets_service.spreadsheets().values().update(
                    spreadsheetId=SPREADSHEET_ID,
                    range=range_name,
                    valueInputOption='RAW',
                    body={'values': values}
                ).execute()
                
                # Update local cache
                self.sheet_data[row_number - 1] = values[0]
                
                print(f'  📝 Updated row {row_number}: {status}')
                
            else:
                # APPEND new row
                self.sheets_service.spreadsheets().values().append(
                    spreadsheetId=SPREADSHEET_ID,
                    range='A:H',
                    valueInputOption='RAW',
                    body={'values': values}
                ).execute()
                
                # Add to local cache
                new_row_number = len(self.sheet_data) + 1
                self.sheet_data.append(values[0])
                self.message_id_to_row[message_id] = new_row_number
                
                print(f'  📝 Appended new row: {status}')
                
        except Exception as e:
            print(f'  ✗ Error logging to sheet: {e}')
    
    def validate_email(self, message):
        """Check if email meets criteria and return detailed status"""
        try:
            headers = message['payload'].get('headers', [])
            subject = next((h['value'] for h in headers if h['name'] == 'Subject'), '')
            label_ids = message.get('labelIds', [])
            
            # Check if it's a reply
            if subject.startswith('Re:') or subject.startswith('RE:'):
                return {
                    'should_process': False,
                    'action': 'move_to_original',
                    'reason': 'Reply email',
                    'current_labels': label_ids
                }
            
            # Check if it's an invoice email by subject pattern
            # Valid patterns: "Invoice XXXXX from Fleet Advisor" or similar
            if 'Invoice' not in subject or 'Fleet Advisor' not in subject:
                return {
                    'should_process': False,
                    'action': 'move_to_other',
                    'reason': 'Not an invoice email - wrong subject format'
                }
            
            # Check if first message in thread
            thread_id = message.get('threadId', '')
            message_id = message.get('id', '')
            if thread_id != message_id:
                return {
                    'should_process': False,
                    'action': 'skip',
                    'reason': 'Not first message in thread'
                }
            
            # Check from header
            from_header = next((h['value'] for h in headers if h['name'] == 'From'), '')
            if '@gofleetadvisor.com' not in from_header:
                return {
                    'should_process': False,
                    'action': 'skip',
                    'reason': 'Sender not @gofleetadvisor.com'
                }
            
            # Check for invoice attachment
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
                return {
                    'should_process': False,
                    'action': 'skip',
                    'reason': 'No invoice PDF attachment found'
                }
            
            return {
                'should_process': True,
                'action': 'process',
                'reason': ''
            }
            
        except Exception as e:
            return {
                'should_process': False,
                'action': 'skip',
                'reason': f'Validation error: {str(e)}'
            }
    
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
        """Extract company name with three-tier matching: exact, trailing dash, fuzzy"""
        try:
            plain_text = self._get_email_body(message, 'plain')
            company_name = ''
            
            if plain_text:
                text_lines = plain_text.split('\n')
                if len(text_lines) > 0:
                    first_line = text_lines[0].strip()
                    # Remove trailing comma and trim again to catch whitespace after comma
                    if first_line.endswith(','):
                        company_name = first_line[:-1].strip()
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
                        # Remove trailing comma and trim again
                        if company_name.endswith(','):
                            company_name = company_name[:-1].strip()
            
            # Format: lowercase and replace spaces with hyphens
            if company_name:
                company_formatted = company_name.lower().replace(' ', '-')
                
                print(f'  Extracted: "{company_name}" -> "{company_formatted}"')
                
                # 1. Try exact match
                if company_formatted in self.valid_companies:
                    print(f'  ✓ Exact match: "{company_formatted}"')
                    return company_formatted
                
                # 2. Try with trailing dash (for companies that legitimately end with dash)
                with_trailing_dash = company_formatted + '-'
                if with_trailing_dash in self.valid_companies:
                    print(f'  ✓ Trailing dash match: "{with_trailing_dash}"')
                    return with_trailing_dash
                
                # 3. Fuzzy match - find closest match within 2 character edits
                fuzzy_match = self._find_fuzzy_match(company_formatted, max_distance=2)
                if fuzzy_match:
                    print(f'  ✓ Fuzzy match: "{company_formatted}" -> "{fuzzy_match}"')
                    return fuzzy_match
                
                print(f'  ✗ No match found for "{company_formatted}"')
                return None
            
            return None
            
        except Exception as e:
            print(f'  ✗ Error extracting company: {e}')
            return None
    
    def _find_fuzzy_match(self, input_name, max_distance=2):
        """Find closest matching company name using Levenshtein distance"""
        best_match = None
        best_distance = max_distance + 1
        
        for valid_name in self.valid_companies.keys():
            distance = self._levenshtein_distance(input_name, valid_name)
            if distance <= max_distance and distance < best_distance:
                best_distance = distance
                best_match = valid_name
        
        return best_match
    
    def _levenshtein_distance(self, s1, s2):
        """Calculate Levenshtein distance between two strings"""
        if len(s1) < len(s2):
            return self._levenshtein_distance(s2, s1)
        
        if len(s2) == 0:
            return len(s1)
        
        previous_row = range(len(s2) + 1)
        for i, c1 in enumerate(s1):
            current_row = [i + 1]
            for j, c2 in enumerate(s2):
                # Cost of insertions, deletions, or substitutions
                insertions = previous_row[j + 1] + 1
                deletions = current_row[j] + 1
                substitutions = previous_row[j] + (c1 != c2)
                current_row.append(min(insertions, deletions, substitutions))
            previous_row = current_row
        
        return previous_row[-1]
    
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
                    att = self.gmail_service.users().messages().attachments().get(
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
        """Process a single email message with Google Sheets logging"""
        headers = message['payload'].get('headers', [])
        subject = next((h['value'] for h in headers if h['name'] == 'Subject'), 'No Subject')
        message_id = message['id']
        
        print(f"\n{subject}")
        
        company = ''
        invoice_filename = ''
        dot_filename = ''
        
        try:
            company = self.extract_company_name(message)
            if not company:
                error_msg = "Company name not found or not in Supabase"
                self.log_to_sheet(message_id, subject, status='failed', error=error_msg)
                self.failed_count += 1
                return
            
            attachments = self.get_attachments(message)
            if not attachments:
                error_msg = "No PDF attachments found"
                self.log_to_sheet(message_id, subject, company=company, status='failed', error=error_msg)
                self.failed_count += 1
                return
            
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
                self.log_to_sheet(message_id, subject, company=company, status='failed', error=error_msg)
                self.failed_count += 1
                return
            
            invoice_metadata = self.extract_metadata_from_pdf(invoice_attachment['data'])
            unit = invoice_metadata['unit']
            vin = invoice_metadata['vin']
            plate = invoice_metadata['plate']
            email_date = self.get_email_date(message)
            
            if dot_attachments:
                invoice_filename = f"{company}__I-{invoice_number}__U-{unit}__V-{vin}__D-{email_date}__P-{plate}.pdf".strip()
                dot_filename = f"{company}__dot__I-{invoice_number}__U-{unit}__V-{vin}__D-{email_date}__P-{plate}.pdf".strip()
                
                invoice_uploaded = self.upload_to_supabase(invoice_attachment['data'], invoice_filename, 'INVOICE')
                print(f"  INVOICE: {invoice_filename}")
                
                dot_pdfs = [att['data'] for att in dot_attachments]
                merged_dot = self.merge_pdfs(dot_pdfs)
                dot_uploaded = self.upload_to_supabase(merged_dot, dot_filename, 'DOT')
                print(f"  DOT: {dot_filename}")
                
                if invoice_uploaded and dot_uploaded:
                    moved = self.move_to_sorted_label(message_id)
                    self.log_to_sheet(message_id, subject, company=company, 
                                    invoice_file=invoice_filename, dot_file=dot_filename, 
                                    status='success')
                    self.processed_count += 1
                else:
                    error_msg = "Upload failed"
                    self.log_to_sheet(message_id, subject, company=company,
                                    invoice_file=invoice_filename, dot_file=dot_filename,
                                    status='failed', error=error_msg)
                    self.failed_count += 1
            else:
                invoice_filename = f"{company}__I-{invoice_number}__U-{unit}__V-{vin}__D-{email_date}__P-{plate}.pdf".strip()
                
                invoice_uploaded = self.upload_to_supabase(invoice_attachment['data'], invoice_filename, 'INVOICE')
                print(f"  INVOICE: {invoice_filename}")
                
                if invoice_uploaded:
                    moved = self.move_to_sorted_label(message_id)
                    self.log_to_sheet(message_id, subject, company=company,
                                    invoice_file=invoice_filename, status='success')
                    self.processed_count += 1
                else:
                    error_msg = "Upload failed"
                    self.log_to_sheet(message_id, subject, company=company,
                                    invoice_file=invoice_filename, status='failed', error=error_msg)
                    self.failed_count += 1
            
        except Exception as e:
            error_msg = str(e)
            self.log_to_sheet(message_id, subject, company=company,
                            invoice_file=invoice_filename, dot_file=dot_filename or 'N/A',
                            status='failed', error=error_msg)
            self.failed_count += 1
    
    def process_inbox(self, limit=None):
        """Process all emails in inbox with cleanup for replies and non-invoices"""
        print("FLEET EMAIL PROCESSOR - GOOGLE SHEETS VERSION")
        print("="*60)
        
        all_messages = []
        page_token = None
        
        while True:
            results = self.gmail_service.users().messages().list(
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
        
        # Count already processed
        already_processed = sum(1 for msg in all_messages if self._is_already_processed(msg['id']))
        
        print(f"Total emails in inbox: {total}")
        print(f"Already processed (success in sheet): {already_processed}")
        print(f"Will attempt to process: {len(all_messages) - already_processed}")
        print("="*60)
        
        for idx, msg in enumerate(all_messages, 1):
            msg_id = msg['id']
            
            if self._is_already_processed(msg_id):
                self.skipped_count += 1
                continue
            
            print(f"[{idx}/{len(all_messages)}]", end=" ")
            
            try:
                message = self.gmail_service.users().messages().get(
                    userId='me',
                    id=msg_id
                ).execute()
                
                headers = message['payload'].get('headers', [])
                subject = next((h['value'] for h in headers if h['name'] == 'Subject'), 'No Subject')
                print(f"{subject[:80]}")
                
                validation = self.validate_email(message)
                
                if validation['action'] == 'move_to_original':
                    # Reply email - move back to original batch label
                    moved, error = self.move_reply_to_original_label(msg_id, validation['current_labels'])
                    self.log_to_sheet(msg_id, subject, status='failed', 
                                     error=f"Reply email - {error}")
                    self.cleaned_count += 1
                    
                elif validation['action'] == 'move_to_other':
                    # Non-invoice email - move to Other label
                    moved = self.move_to_other_label(msg_id)
                    self.log_to_sheet(msg_id, subject, status='failed', 
                                     error=validation['reason'])
                    self.cleaned_count += 1
                    
                elif validation['action'] == 'skip':
                    # Skip without moving
                    print(f"  ⏭️  Skipped: {validation['reason']}")
                    self.skipped_count += 1
                    
                elif validation['should_process']:
                    # Process normally
                    self.process_single_email(message)
                
                # Rate limiting
                if idx < len(all_messages):
                    if idx % BATCH_SIZE == 0:
                        time.sleep(BATCH_DELAY)
                    else:
                        time.sleep(DELAY_BETWEEN_EMAILS)
                
            except Exception as e:
                print(f"  ✗ Error: {e}")
                self.failed_count += 1
        
        print("\n" + "="*60)
        print("COMPLETE")
        print(f"Processed: {self.processed_count}")
        print(f"Cleaned up: {self.cleaned_count}")
        print(f"Skipped: {self.skipped_count}")
        print(f"Failed: {self.failed_count}")
        print("="*60)

if __name__ == "__main__":
    processor = FleetEmailProcessor()
    processor.process_inbox(limit=None)