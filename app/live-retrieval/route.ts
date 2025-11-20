/* eslint-disable @typescript-eslint/no-explicit-any */
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
  if (!process.env.GOOGLE_SERVICE_ACCOUNT_GMAIL) {
    throw new Error('GOOGLE_SERVICE_ACCOUNT_GMAIL environment variable not set')
  }
  return JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_GMAIL)
}

function getSheetsCredentials() {
  if (!process.env.GOOGLE_SERVICE_ACCOUNT_SHEETS) {
    throw new Error('GOOGLE_SERVICE_ACCOUNT_SHEETS environment variable not set')
  }
  return JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_SHEETS)
}

// Constants
const EMAIL_ADDRESS = 'donotreply@gofleetadvisor.com'
const SPREADSHEET_ID = process.env.GOOGLE_SHEET_ID || 'YOUR_SHEET_ID_HERE'
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
  private gmailService!: gmail_v1.Gmail
  private sheetsService!: ReturnType<typeof google.sheets>
  private validCompanies: Map<string, string> = new Map()
  private sortedLabelId: string | null = null
  private otherLabelId: string | null = null
  private batchLabels: Map<string, string> = new Map()
  private processedMessageIds: Set<string> = new Set()

  constructor() {
    // Constructor is synchronous, initialization happens in processInbox
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
    
    // Load valid companies, processed messages, and label
    await this.loadValidCompanies()
    await this.loadProcessedMessageIds()
    await this.getOrCreateLabel()
  }

  private async loadValidCompanies() {
    try {
      const { data, error } = await supabase
        .from('companies')
        .select('name')
      
      if (error) {
        console.error('loadValidCompanies error:', error)
      }
      
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

  private async loadProcessedMessageIds() {
    try {
      const response = await this.sheetsService.spreadsheets.values.get({
        spreadsheetId: SPREADSHEET_ID,
        range: 'A:H'
      })
      
      const rows = response.data.values || []
      
      // Skip header row, load ALL message IDs (success AND failed)
      for (let i = 1; i < rows.length; i++) {
        const row = rows[i]
        if (row.length >= 2) {
          const messageId = row[1] // Column B
          if (messageId) {
            this.processedMessageIds.add(messageId)
          }
        }
      }
      
      console.log(`Loaded ${this.processedMessageIds.size} processed message IDs from spreadsheet`)
    } catch (error) {
      console.error('Error loading processed message IDs:', error)
    }
  }

  private async getOrCreateLabel(): Promise<void> {
    try {
      const response = await this.gmailService.users.labels.list({ userId: 'me' })
      const labels = response.data.labels || []
      
      // Find or create sorted label
      const existingLabel = labels.find(label => label.name === SORTED_LABEL)
      if (existingLabel) {
        this.sortedLabelId = existingLabel.id!
      } else {
        const createResponse = await this.gmailService.users.labels.create({
          userId: 'me',
          requestBody: {
            name: SORTED_LABEL,
            labelListVisibility: 'labelShow',
            messageListVisibility: 'show'
          }
        })
        this.sortedLabelId = createResponse.data.id!
      }
      
      // Find or create Other label
      const otherLabel = labels.find(label => label.name === 'Other')
      if (otherLabel) {
        this.otherLabelId = otherLabel.id!
      } else {
        const createResponse = await this.gmailService.users.labels.create({
          userId: 'me',
          requestBody: {
            name: 'Other',
            labelListVisibility: 'labelShow',
            messageListVisibility: 'show'
          }
        })
        this.otherLabelId = createResponse.data.id!
      }
      
      // Load all Batch_X_sorted labels
      for (const label of labels) {
        if (label.name?.startsWith('Batch_') && label.name.endsWith('_sorted')) {
          this.batchLabels.set(label.id!, label.name)
        }
      }
      
      console.log(`Found ${this.batchLabels.size} batch labels: ${Array.from(this.batchLabels.values()).join(', ')}`)
      
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
      
      // Add to processed set (both success and failed)
      this.processedMessageIds.add(messageId)
    } catch (error) {
      console.error('Error logging to sheet:', error)
    }
  }

  private getEmailBody(message: any, bodyType: 'plain' | 'html'): string | null {
    try {
      const payload = message.payload
      
      // Check parts
      if (payload.parts) {
        for (const part of payload.parts) {
          if (part.mimeType === `text/${bodyType}`) {
            if (part.body?.data) {
              return Buffer.from(part.body.data, 'base64').toString('utf-8')
            }
          }
        }
      }
      
      // Check main body
      if (payload.mimeType === `text/${bodyType}`) {
        if (payload.body?.data) {
          return Buffer.from(payload.body.data, 'base64').toString('utf-8')
        }
      }
      
      return null
    } catch (error) {
      console.error('Error getting email body:', error)
      return null
    }
  }

  private extractCompanyName(message: any): string | null {
    try {
      // Get plain text body first
      let companyName = ''
      const plainText = this.getEmailBody(message, 'plain')
      
      if (plainText) {
        const textLines = plainText.split('\n')
        if (textLines.length > 0) {
          let firstLine = textLines[0].trim()
          // Remove trailing comma and trim again to catch whitespace after comma
          if (firstLine.endsWith(',')) {
            firstLine = firstLine.slice(0, -1).trim()
          }
          companyName = firstLine
        }
      }
      
      // Fallback to HTML if no plain text
      if (!companyName) {
        const htmlText = this.getEmailBody(message, 'html')
        if (htmlText) {
          // Look for first span content
          const match = htmlText.match(/<span[^>]*>([^<]+)<\/span>/)
          if (match) {
            companyName = match[1]
            // Clean HTML entities
            companyName = companyName.replace(/&amp;/g, '&')
            companyName = companyName.replace(/&nbsp;/g, ' ')
            companyName = companyName.replace(/<[^>]*>/g, '')
            companyName = companyName.trim()
            if (companyName.endsWith(',')) {
              companyName = companyName.slice(0, -1).trim()
            }
          }
        }
      }
      
      // Format company name: lowercase and replace spaces with hyphens
      if (companyName) {
        const companyFormatted = companyName.toLowerCase().replace(/ /g, '-')
        
        console.log(`Extracted company: "${companyName}" -> formatted: "${companyFormatted}"`)
        
        // 1. Try exact match
        if (this.validCompanies.has(companyFormatted)) {
          console.log(`Exact match found: "${companyFormatted}"`)
          return companyFormatted
        }
        
        // 2. Try with trailing dash (for companies that legitimately end with dash)
        const withTrailingDash = companyFormatted + '-'
        if (this.validCompanies.has(withTrailingDash)) {
          console.log(`Match with trailing dash: "${withTrailingDash}"`)
          return withTrailingDash
        }
        
        // 3. Fuzzy match - find closest match within 2 character edits (Levenshtein distance)
        const fuzzyMatch = this.findFuzzyMatch(companyFormatted, 2)
        if (fuzzyMatch) {
          console.log(`Fuzzy match found: "${companyFormatted}" -> "${fuzzyMatch}"`)
          return fuzzyMatch
        }
        
        console.log(`Company "${companyFormatted}" not found in valid companies`)
        return null
      }
      
      return null
    } catch (error) {
      console.error('Error extracting company:', error)
      return null
    }
  }

  private findFuzzyMatch(input: string, maxDistance: number): string | null {
    let bestMatch: string | null = null
    let bestDistance = maxDistance + 1
    
    for (const [validName] of this.validCompanies) {
      const distance = this.levenshteinDistance(input, validName)
      if (distance <= maxDistance && distance < bestDistance) {
        bestDistance = distance
        bestMatch = validName
      }
    }
    
    return bestMatch
  }

  private levenshteinDistance(str1: string, str2: string): number {
    const len1 = str1.length
    const len2 = str2.length
    const matrix: number[][] = []

    // Initialize matrix
    for (let i = 0; i <= len1; i++) {
      matrix[i] = [i]
    }
    for (let j = 0; j <= len2; j++) {
      matrix[0][j] = j
    }

    // Calculate distances
    for (let i = 1; i <= len1; i++) {
      for (let j = 1; j <= len2; j++) {
        const cost = str1[i - 1] === str2[j - 1] ? 0 : 1
        matrix[i][j] = Math.min(
          matrix[i - 1][j] + 1,      // deletion
          matrix[i][j - 1] + 1,      // insertion
          matrix[i - 1][j - 1] + cost // substitution
        )
      }
    }

    return matrix[len1][len2]
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

  private extractInvoiceNumber(attachments: Attachment[]): string {
    // Look for invoice number in invoice filename
    const invoiceAttachment = attachments.find(att => 
      att.filename.toLowerCase().startsWith('invoice')
    )
    
    if (invoiceAttachment) {
      const match = invoiceAttachment.filename.match(/invoice[-_\s]*(\d+)/i)
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
      // Trim filename just like Python does
      filename = filename.trim()
      
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

  private async moveReplyToOriginal(messageId: string, currentLabels: string[]): Promise<{ moved: boolean; labelName: string }> {
    // Find existing batch label
    let batchLabelId: string | null = null
    let batchLabelName = 'unknown'
    
    for (const labelId of currentLabels) {
      if (this.batchLabels.has(labelId)) {
        batchLabelId = labelId
        batchLabelName = this.batchLabels.get(labelId)!
        break
      }
    }
    
    try {
      if (batchLabelId) {
        // Has batch label - just remove from INBOX
        await this.gmailService.users.messages.modify({
          userId: 'me',
          id: messageId,
          requestBody: {
            removeLabelIds: ['INBOX']
          }
        })
        console.log(`Kept reply in ${batchLabelName}, removed from INBOX`)
        return { moved: true, labelName: batchLabelName }
      } else {
        // No batch label - this is a new reply, just remove from INBOX
        await this.gmailService.users.messages.modify({
          userId: 'me',
          id: messageId,
          requestBody: {
            removeLabelIds: ['INBOX']
          }
        })
        console.log('Reply removed from INBOX')
        return { moved: true, labelName: 'removed from inbox' }
      }
    } catch (error) {
      console.error('Error moving reply:', error)
      return { moved: false, labelName: batchLabelName }
    }
  }

  private async moveToOther(messageId: string): Promise<boolean> {
    if (!this.otherLabelId) return false
    
    try {
      await this.gmailService.users.messages.modify({
        userId: 'me',
        id: messageId,
        requestBody: {
          addLabelIds: [this.otherLabelId],
          removeLabelIds: ['INBOX']
        }
      })
      console.log('Moved to Other label')
      return true
    } catch (error) {
      console.error('Error moving to Other:', error)
      return false
    }
  }

  private validateEmail(message: any): { valid: boolean; action: string; reason: string; currentLabels?: string[] } {
    const headers = message.payload?.headers || []
    const subject = headers.find((h: any) => h.name === 'Subject')?.value || ''
    const labelIds = message.labelIds || []
    
    // Check if it's a reply - should move back to original label
    if (subject.startsWith('Re:') || subject.startsWith('RE:')) {
      return { 
        valid: false, 
        action: 'move_to_original',
        reason: 'Reply email',
        currentLabels: labelIds
      }
    }
    
    // Check if subject matches invoice pattern
    if (!subject.includes('Invoice') || !subject.includes('Fleet Advisor')) {
      return { 
        valid: false, 
        action: 'move_to_other',
        reason: 'Not an invoice email - wrong subject format'
      }
    }
    
    // Check if it's the first message in thread
    const threadId = message.threadId
    const messageId = message.id
    if (threadId !== messageId) {
      return { 
        valid: false, 
        action: 'skip',
        reason: 'Not first message in thread' 
      }
    }
    
    // Check if already has the sorted label
    if (this.sortedLabelId && labelIds.includes(this.sortedLabelId)) {
      return { 
        valid: false, 
        action: 'skip',
        reason: 'Already has sorted label' 
      }
    }
    
    // Check From header
    const fromHeader = headers.find((h: any) => h.name === 'From')?.value || ''
    if (!fromHeader.includes('@gofleetadvisor.com')) {
      return { 
        valid: false, 
        action: 'skip',
        reason: 'Sender not @gofleetadvisor.com' 
      }
    }
    
    // Check for invoice attachment
    const parts = this.getMessageParts(message.payload)
    const hasInvoice = parts.some(part => {
      const filename = part.filename?.toLowerCase() || ''
      return filename.startsWith('invoice') && filename.endsWith('.pdf')
    })
    
    if (!hasInvoice) {
      return { 
        valid: false, 
        action: 'skip',
        reason: 'No invoice PDF attachment found' 
      }
    }
    
    return { valid: true, action: 'process', reason: '' }
  }

  async processEmail(messageId: string): Promise<void> {
    try {
      // Check if already processed
      if (this.processedMessageIds.has(messageId)) {
        console.log(`Skipping already processed message: ${messageId}`)
        return
      }
      
      const message = await this.gmailService.users.messages.get({
        userId: 'me',
        id: messageId
      })
      
      const headers = message.data.payload?.headers || []
      const subject = headers.find((h: any) => h.name === 'Subject')?.value || 'No Subject'
      
      console.log(`Processing: ${subject}`)
      
      // Validate and determine action
      const validationResult = this.validateEmail(message.data)
      
      if (validationResult.action === 'move_to_original') {
        // Reply email - move back to original batch label or just remove from INBOX
        const result = await this.moveReplyToOriginal(messageId, validationResult.currentLabels || [])
        await this.logToSheet(
          messageId, 
          subject, 
          '', '', '', 
          'failed', 
          `Reply email - ${result.labelName}`
        )
        return
      }
      
      if (validationResult.action === 'move_to_other') {
        // Non-invoice email - move to Other label
        await this.moveToOther(messageId)
        await this.logToSheet(messageId, subject, '', '', '', 'failed', validationResult.reason)
        return
      }
      
      if (validationResult.action === 'skip') {
        // Skip without moving
        console.log(`Skipped: ${validationResult.reason}`)
        return
      }
      
      if (!validationResult.valid) {
        await this.logToSheet(messageId, subject, '', '', '', 'failed', validationResult.reason)
        console.log(`Validation failed: ${validationResult.reason}`)
        return
      }
      
      // Extract company FROM EMAIL BODY
      const company = this.extractCompanyName(message.data)
      if (!company) {
        await this.logToSheet(messageId, subject, '', '', '', 'failed', 'Company not found or invalid')
        console.log('Company not found or invalid')
        return
      }
      
      console.log(`Company validated: ${company}`)
      
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
      const invoiceFilename = `${company}__I-${invoiceNumber}__U-${metadata.unit}__V-${metadata.vin}__D-${emailDate}__P-${metadata.plate}.pdf`.trim()
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
        dotFilename = `${company}__dot__I-${invoiceNumber}__U-${metadata.unit}__V-${metadata.vin}__D-${emailDate}__P-${metadata.plate}.pdf`.trim()
        
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
      // Get messages from inbox ONLY (not already sorted)
      const response = await this.gmailService.users.messages.list({
        userId: 'me',
        labelIds: ['INBOX'],
        q: '-label:Batch_3_sorted',
        maxResults: 50
      })
      
      const messages = response.data.messages || []
      console.log(`Found ${messages.length} messages in inbox (excluding already sorted)`)
      
      for (const message of messages) {
        try {
          // Check if already processed before fetching full message
          if (this.processedMessageIds.has(message.id!)) {
            skipped++
            continue
          }
          
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
  if (process.env.NODE_ENV === 'production' && process.env.CRON_SECRET) {
    if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }
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