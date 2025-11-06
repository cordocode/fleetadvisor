import { NextResponse } from 'next/server'
import { google, gmail_v1 } from 'googleapis'
import { createClient } from '@supabase/supabase-js'
import OpenAI from 'openai'
import { PDFDocument } from 'pdf-lib'
import pdf from 'pdf-parse'

// Initialize clients
const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY!
})

// Service Account credentials
function getGmailCredentials() {
  // Try Vercel env first, fall back to local file
  if (process.env.GOOGLE_SERVICE_ACCOUNT_GMAIL) {
    return JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_GMAIL)
  }
  // Local development - use file
  return require('../../../live-retrieval/private/google-service-account.json')
}

function getSheetsCredentials() {
  // Try Vercel env first, fall back to local file
  if (process.env.GOOGLE_SERVICE_ACCOUNT_SHEETS) {
    return JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_SHEETS)
  }
  // Local development - use file
  return require('../../../live-retrieval/private/sheets-processor.json')
}

// Constants
const EMAIL_ADDRESS = 'donotreply@gofleetadvisor.com'
const SPREADSHEET_ID = process.env.GOOGLE_SHEET_ID || 'YOUR_SHEET_ID_HERE' // You'll need to add this
const SORTED_LABEL = 'Batch_3_sorted'

interface EmailMetadata {
  unit: string
  vin: string
  plate: string
}

interface Attachment {
  filename: string
  mimeType: string
  data: Buffer
}

class FleetEmailProcessor {
  private gmailService: gmail_v1.Gmail
  private sheetsService: any
  private validCompanies: Map<string, string> = new Map()
  private sortedLabelId: string | null = null

  constructor() {
    this.initializeServices()
  }

  private async initializeServices() {
    // Initialize Gmail service with domain delegation
    const gmailAuth = new google.auth.GoogleAuth({
      credentials: getGmailCredentials(),
      scopes: [
        'https://www.googleapis.com/auth/gmail.readonly',
        'https://www.googleapis.com/auth/gmail.modify'
      ]
    })
    
    const gmailClient = await gmailAuth.getClient() as any
    gmailClient.subject = EMAIL_ADDRESS
    this.gmailService = google.gmail({ version: 'v1', auth: gmailClient })

    // Initialize Sheets service
    const sheetsAuth = new google.auth.GoogleAuth({
      credentials: getSheetsCredentials(),
      scopes: ['https://www.googleapis.com/auth/spreadsheets']
    })
    
    this.sheetsService = google.sheets({ version: 'v4', auth: sheetsAuth })
    
    // Load valid companies and label
    await this.loadValidCompanies()
    await this.getOrCreateLabel()
  }

  private async loadValidCompanies() {
    try {
      const { data, error } = await supabase
        .from('companies')
        .select('name')
      
      if (data) {
        data.forEach(company => {
          this.validCompanies.set(company.name, company.name)
        })
      }
      
      console.log(`Loaded ${this.validCompanies.size} valid companies`)
    } catch (error) {
      console.error('Error loading companies:', error)
    }
  }

  private async getOrCreateLabel(): Promise<void> {
    try {
      const response = await this.gmailService.users.labels.list({ userId: 'me' })
      const labels = response.data.labels || []
      
      const existingLabel = labels.find(label => label.name === SORTED_LABEL)
      if (existingLabel) {
        this.sortedLabelId = existingLabel.id!
        return
      }
      
      // Create label if it doesn't exist
      const createResponse = await this.gmailService.users.labels.create({
        userId: 'me',
        requestBody: {
          name: SORTED_LABEL,
          labelListVisibility: 'labelShow',
          messageListVisibility: 'show'
        }
      })
      
      this.sortedLabelId = createResponse.data.id!
    } catch (error) {
      console.error('Error with label:', error)
    }
  }

  private async logToSheet(
    messageId: string,
    subject: string,
    company: string,
    invoiceFile: string,
    dotFile: string,
    status: 'success' | 'failed',
    error: string = ''
  ) {
    try {
      const values = [[
        new Date().toISOString(),
        messageId,
        subject.substring(0, 100),
        company,
        invoiceFile,
        dotFile || 'N/A',
        status,
        error.substring(0, 200)
      ]]
      
      await this.sheetsService.spreadsheets.values.append({
        spreadsheetId: SPREADSHEET_ID,
        range: 'A:H',
        valueInputOption: 'RAW',
        requestBody: { values }
      })
    } catch (error) {
      console.error('Error logging to sheet:', error)
    }
  }

  private async getAttachments(message: any): Promise<Attachment[]> {
    const attachments: Attachment[] = []
    const parts = this.getMessageParts(message.payload)
    
    for (const part of parts) {
      if (part.filename && part.body?.attachmentId) {
        try {
          const attachment = await this.gmailService.users.messages.attachments.get({
            userId: 'me',
            messageId: message.id,
            id: part.body.attachmentId
          })
          
          if (attachment.data.data) {
            const data = Buffer.from(attachment.data.data, 'base64')
            attachments.push({
              filename: part.filename,
              mimeType: part.mimeType || 'application/octet-stream',
              data
            })
          }
        } catch (error) {
          console.error(`Error fetching attachment ${part.filename}:`, error)
        }
      }
    }
    
    return attachments
  }

  private getMessageParts(payload: any): any[] {
    let parts: any[] = []
    
    if (payload.parts) {
      for (const part of payload.parts) {
        if (part.parts) {
          parts = parts.concat(this.getMessageParts(part))
        } else {
          parts.push(part)
        }
      }
    } else if (payload.body) {
      parts.push(payload)
    }
    
    return parts
  }

  private extractCompanyName(message: any): string | null {
    const payload = message.payload
    const headers = payload.headers || []
    const subject = headers.find((h: any) => h.name === 'Subject')?.value || ''
    
    // Extract company name from subject (pattern: "Company - Fleet Advisor...")
    const match = subject.match(/^([^-]+)\s*-\s*Fleet Advisor/i)
    if (!match) return null
    
    const rawCompany = match[1].trim()
    
    // Normalize company name to kebab-case
    const normalizedCompany = rawCompany
      .toLowerCase()
      .replace(/[&]/g, 'and')
      .replace(/[\s,.'()]+/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '')
    
    // Check if it's a valid company
    if (this.validCompanies.has(normalizedCompany)) {
      return normalizedCompany
    }
    
    // Try to find a close match
    for (const [companyName] of this.validCompanies) {
      if (companyName.includes(normalizedCompany) || normalizedCompany.includes(companyName)) {
        return companyName
      }
    }
    
    return null
  }

  private extractInvoiceNumber(attachments: Attachment[]): string {
    // Look for invoice number in invoice filename
    const invoiceAttachment = attachments.find(att => 
      att.filename.toLowerCase().startsWith('invoice')
    )
    
    if (invoiceAttachment) {
      const match = invoiceAttachment.filename.match(/invoice[_-]?(\d+)/i)
      if (match) {
        return match[1]
      }
    }
    
    return 'NA'
  }

  private async extractMetadataFromPDF(pdfData: Buffer): Promise<EmailMetadata> {
    try {
      const data = await pdf(pdfData)
      const text = data.text
      
      // Use OpenAI to extract metadata
      const completion = await openai.chat.completions.create({
        model: 'gpt-3.5-turbo',
        messages: [
          {
            role: 'system',
            content: `Extract vehicle information from invoice text. Return JSON with exactly these keys:
            - unit: The unit number (uppercase, no spaces) or "NA" if not found
            - vin: The VIN number (17 characters, uppercase, no spaces) or "NA" if not found  
            - plate: The plate/license number (uppercase, no spaces) or "NA" if not found
            
            Remove all whitespace and convert to uppercase. Return ONLY valid JSON.`
          },
          {
            role: 'user',
            content: text
          }
        ],
        temperature: 0,
        response_format: { type: 'json_object' }
      })
      
      const metadata = JSON.parse(completion.choices[0].message.content || '{}')
      
      // Clean and validate
      const cleanedUnit = (metadata.unit || 'NA').toUpperCase().replace(/\s+/g, '')
      const cleanedVin = (metadata.vin || 'NA').toUpperCase().replace(/\s+/g, '')
      const cleanedPlate = (metadata.plate || 'NA').toUpperCase().replace(/\s+/g, '')
      
      // If unit is NA but VIN exists, use last 8 of VIN
      let finalUnit = cleanedUnit
      if ((cleanedUnit === 'NA' || cleanedUnit === '') && cleanedVin !== 'NA' && cleanedVin.length >= 8) {
        finalUnit = cleanedVin.slice(-8)
      }
      
      return {
        unit: finalUnit,
        vin: cleanedVin,
        plate: cleanedPlate
      }
    } catch (error) {
      console.error('Error extracting metadata:', error)
      return { unit: 'NA', vin: 'NA', plate: 'NA' }
    }
  }

  private async mergePDFs(pdfBuffers: Buffer[]): Promise<Buffer> {
    const mergedPdf = await PDFDocument.create()
    
    for (const pdfBuffer of pdfBuffers) {
      try {
        const pdf = await PDFDocument.load(pdfBuffer)
        const pages = await mergedPdf.copyPages(pdf, pdf.getPageIndices())
        pages.forEach(page => mergedPdf.addPage(page))
      } catch (error) {
        console.error('Error merging PDF:', error)
      }
    }
    
    const mergedBytes = await mergedPdf.save()
    return Buffer.from(mergedBytes)
  }

  private async uploadToSupabase(fileData: Buffer, filename: string, bucket: 'INVOICE' | 'DOT'): Promise<boolean> {
    try {
      // Check if file already exists
      const { data: existingFiles } = await supabase.storage
        .from(bucket)
        .list('', { search: filename })
      
      if (existingFiles && existingFiles.length > 0) {
        console.log(`File ${filename} already exists in ${bucket} bucket`)
        return true
      }
      
      // Upload file
      const { error } = await supabase.storage
        .from(bucket)
        .upload(filename, fileData, {
          contentType: 'application/pdf',
          upsert: false
        })
      
      if (error) {
        console.error(`Upload error for ${filename}:`, error)
        return false
      }
      
      console.log(`Successfully uploaded ${filename} to ${bucket}`)
      return true
    } catch (error) {
      console.error(`Error uploading ${filename}:`, error)
      return false
    }
  }

  private getEmailDate(message: any): string {
    const headers = message.payload?.headers || []
    const dateHeader = headers.find((h: any) => h.name === 'Date')?.value
    
    if (dateHeader) {
      const date = new Date(dateHeader)
      const month = String(date.getMonth() + 1).padStart(2, '0')
      const day = String(date.getDate()).padStart(2, '0')
      const year = date.getFullYear()
      return `${month}${day}${year}`
    }
    
    return new Date().toISOString().split('T')[0].replace(/-/g, '')
  }

  private async moveToSorted(messageId: string): Promise<boolean> {
    if (!this.sortedLabelId) return false
    
    try {
      await this.gmailService.users.messages.modify({
        userId: 'me',
        id: messageId,
        requestBody: {
          addLabelIds: [this.sortedLabelId],
          removeLabelIds: ['INBOX']
        }
      })
      return true
    } catch (error) {
      console.error('Error moving message:', error)
      return false
    }
  }

  private shouldProcessEmail(message: any): boolean {
    const headers = message.payload?.headers || []
    const subject = headers.find((h: any) => h.name === 'Subject')?.value || ''
    
    // Skip replies
    if (subject.startsWith('Re:') || subject.startsWith('RE:')) {
      return false
    }
    
    // Check if it's the first message in thread
    const threadId = message.threadId
    const messageId = message.id
    if (threadId !== messageId) {
      return false
    }
    
    // Must have Fleet Advisor in subject
    if (!subject.includes('Fleet Advisor')) {
      return false
    }
    
    return true
  }

  async processEmail(messageId: string): Promise<void> {
    try {
      const message = await this.gmailService.users.messages.get({
        userId: 'me',
        id: messageId
      })
      
      const headers = message.data.payload?.headers || []
      const subject = headers.find((h: any) => h.name === 'Subject')?.value || 'No Subject'
      
      // Check if we should process this email
      if (!this.shouldProcessEmail(message.data)) {
        console.log(`Skipping email: ${subject}`)
        return
      }
      
      console.log(`Processing: ${subject}`)
      
      // Extract company
      const company = this.extractCompanyName(message.data)
      if (!company) {
        await this.logToSheet(messageId, subject, '', '', '', 'failed', 'Company not found or invalid')
        console.log('Company not found or invalid')
        return
      }
      
      // Get attachments
      const attachments = await this.getAttachments(message.data)
      const pdfAttachments = attachments.filter(att => att.filename.toLowerCase().endsWith('.pdf'))
      
      if (pdfAttachments.length === 0) {
        await this.logToSheet(messageId, subject, company, '', '', 'failed', 'No PDF attachments')
        console.log('No PDF attachments found')
        return
      }
      
      // Separate invoice and DOT attachments
      const invoiceAttachment = pdfAttachments.find(att => 
        att.filename.toLowerCase().startsWith('invoice')
      )
      
      if (!invoiceAttachment) {
        await this.logToSheet(messageId, subject, company, '', '', 'failed', 'No invoice attachment')
        console.log('No invoice attachment found')
        return
      }
      
      const dotAttachments = pdfAttachments.filter(att => 
        !att.filename.toLowerCase().startsWith('invoice')
      )
      
      // Extract metadata
      const invoiceNumber = this.extractInvoiceNumber(attachments)
      const metadata = await this.extractMetadataFromPDF(invoiceAttachment.data)
      const emailDate = this.getEmailDate(message.data)
      
      // Build filenames
      const invoiceFilename = `${company}__I-${invoiceNumber}__U-${metadata.unit}__V-${metadata.vin}__D-${emailDate}__P-${metadata.plate}.pdf`
      let dotFilename = ''
      
      // Upload invoice
      const invoiceUploaded = await this.uploadToSupabase(
        invoiceAttachment.data,
        invoiceFilename,
        'INVOICE'
      )
      
      // Handle DOT files if present
      let dotUploaded = false
      if (dotAttachments.length > 0) {
        dotFilename = `${company}__dot__I-${invoiceNumber}__U-${metadata.unit}__V-${metadata.vin}__D-${emailDate}__P-${metadata.plate}.pdf`
        
        // Merge DOT PDFs if multiple
        const dotData = dotAttachments.length === 1
          ? dotAttachments[0].data
          : await this.mergePDFs(dotAttachments.map(att => att.data))
        
        dotUploaded = await this.uploadToSupabase(dotData, dotFilename, 'DOT')
      }
      
      // Move to sorted if successful
      if (invoiceUploaded && (dotAttachments.length === 0 || dotUploaded)) {
        await this.moveToSorted(messageId)
        await this.logToSheet(
          messageId,
          subject,
          company,
          invoiceFilename,
          dotFilename,
          'success'
        )
        console.log('Successfully processed email')
      } else {
        await this.logToSheet(
          messageId,
          subject,
          company,
          invoiceFilename,
          dotFilename,
          'failed',
          'Upload failed'
        )
        console.log('Failed to upload files')
      }
      
    } catch (error: any) {
      console.error('Error processing email:', error)
      await this.logToSheet(
        messageId,
        'Error',
        '',
        '',
        '',
        'failed',
        error.message || 'Unknown error'
      )
    }
  }

  async processInbox(): Promise<{ processed: number; failed: number; skipped: number }> {
    await this.initializeServices()
    
    let processed = 0
    let failed = 0
    let skipped = 0
    
    try {
      // Get messages from inbox
      const response = await this.gmailService.users.messages.list({
        userId: 'me',
        labelIds: ['INBOX'],
        maxResults: 50 // Process up to 50 emails per run
      })
      
      const messages = response.data.messages || []
      console.log(`Found ${messages.length} messages in inbox`)
      
      for (const message of messages) {
        try {
          await this.processEmail(message.id!)
          processed++
        } catch (error) {
          console.error(`Failed to process message ${message.id}:`, error)
          failed++
        }
        
        // Small delay between emails to avoid rate limits
        await new Promise(resolve => setTimeout(resolve, 1000))
      }
      
    } catch (error) {
      console.error('Error accessing inbox:', error)
    }
    
    return { processed, failed, skipped }
  }
}

// Cron job handler
export async function GET(request: Request) {
  // Verify this is coming from Vercel Cron (in production)
  const authHeader = request.headers.get('authorization')
  if (process.env.NODE_ENV === 'production' && authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  
  console.log('=== Fleet Email Processor Cron Job Started ===')
  console.log('Timestamp:', new Date().toISOString())
  
  try {
    const processor = new FleetEmailProcessor()
    const results = await processor.processInbox()
    
    console.log('=== Processing Complete ===')
    console.log('Results:', results)
    
    return NextResponse.json({
      success: true,
      timestamp: new Date().toISOString(),
      results
    })
  } catch (error: any) {
    console.error('Cron job error:', error)
    return NextResponse.json({
      success: false,
      error: error.message || 'Unknown error',
      timestamp: new Date().toISOString()
    }, { status: 500 })
  }
}

// Manual trigger for testing
export async function POST(request: Request) {
  // Allow manual triggering in development
  if (process.env.NODE_ENV !== 'development') {
    return NextResponse.json({ error: 'Method not allowed' }, { status: 405 })
  }
  
  return GET(request)
}