// app/api/ai/tools/get_document_counts/route.ts
import { NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

interface CountParams {
  docType: 'dot' | 'invoice'
  company?: string
  unit?: string
  invoice?: string
  vin?: string
  plate?: string
  dateRange?: string
}

interface Context {
  isAdmin: boolean
  userCompany: string | null
  userId: string
}

// Parse date range into start and end dates
function parseDateRange(dateRange: string): { start: Date; end: Date } | null {
  const now = new Date()
  
  switch (dateRange) {
    case 'last_week': {
      const end = new Date(now)
      const start = new Date(now)
      start.setDate(start.getDate() - 7)
      return { start, end }
    }
    case 'this_week': {
      const start = new Date(now)
      start.setDate(start.getDate() - now.getDay())
      const end = new Date(now)
      return { start, end }
    }
    case 'last_month': {
      const end = new Date(now)
      const start = new Date(now)
      start.setMonth(start.getMonth() - 1)
      return { start, end }
    }
    case 'this_month': {
      const start = new Date(now.getFullYear(), now.getMonth(), 1)
      const end = new Date(now)
      return { start, end }
    }
    default:
      if (dateRange.includes(' to ')) {
        const [startStr, endStr] = dateRange.split(' to ')
        return {
          start: new Date(startStr),
          end: new Date(endStr)
        }
      }
      return null
  }
}

// Check if file date is in range
function isDateInRange(fileDate: string, range: { start: Date; end: Date }): boolean {
  if (fileDate.length !== 8) return false
  
  const month = parseInt(fileDate.substring(0, 2))
  const day = parseInt(fileDate.substring(2, 4))
  const year = parseInt(fileDate.substring(4, 8))
  
  if (month < 1 || month > 12 || day < 1 || day > 31) return false
  
  const date = new Date(year, month - 1, day)
  return date >= range.start && date <= range.end
}

// Extract metadata from filename
function parseFileName(fileName: string) {
  const companyMatch = fileName.match(/^([^_]+)__/)
  const invoiceMatch = fileName.match(/I-([^_]+)__/)
  const unitMatch = fileName.match(/U-([^_]+)__/)
  const vinMatch = fileName.match(/V-([^_]+)__/)
  const plateMatch = fileName.match(/P-([^.]+)/)
  const dateMatch = fileName.match(/D-(\d{8})/)
  const isDot = fileName.includes('__dot__')
  
  return {
    company: companyMatch ? companyMatch[1] : 'unknown',
    invoice: invoiceMatch ? invoiceMatch[1] : 'NA',
    unit: unitMatch ? unitMatch[1] : 'NA',
    vin: vinMatch ? vinMatch[1] : 'NA',
    plate: plateMatch ? plateMatch[1] : 'NA',
    date: dateMatch ? dateMatch[1] : 'unknown',
    isDot
  }
}

export async function POST(request: Request) {
  try {
    const body = await request.json()
    const countParams: CountParams = body
    const context: Context = body.context || { isAdmin: false, userCompany: null, userId: '' }
    
    console.log('=== GET DOCUMENT COUNTS ===')
    console.log('Count params:', countParams)
    console.log('Context:', context)
    
    // Validate required parameters
    if (!countParams.docType) {
      return NextResponse.json({
        success: false,
        error: 'Document type (dot or invoice) is required'
      })
    }
    
    // For non-admin users, force company to their own
    if (!context.isAdmin && context.userCompany) {
      countParams.company = context.userCompany
    }
    
    // Determine which bucket to check
    const bucket = countParams.docType === 'dot' ? 'DOT' : 'INVOICE'
    
    // List files in the appropriate bucket
    const { data: files, error } = await supabase
      .storage
      .from(bucket)
      .list('', {
        limit: 1000,
        offset: 0
      })
    
    if (error) {
      console.error('Storage error:', error)
      return NextResponse.json(
        { success: false, error: 'Failed to list files' },
        { status: 500 }
      )
    }
    
    // Parse date range if provided
    const dateFilter = countParams.dateRange 
      ? parseDateRange(countParams.dateRange)
      : null
    
    // Count matching files
    let matchingCount = 0
    const companyCounts: Record<string, number> = {}
    
    for (const file of (files || [])) {
      // Only process PDF files
      if (!file.name.endsWith('.pdf')) continue
      
      const metadata = parseFileName(file.name)
      
      // For DOT bucket, must have __dot__ marker
      // For INVOICE bucket, must NOT have __dot__ marker
      if (countParams.docType === 'dot' && !metadata.isDot) continue
      if (countParams.docType === 'invoice' && metadata.isDot) continue
      
      // Apply filters
      if (countParams.company && metadata.company !== countParams.company) continue
      if (countParams.unit && countParams.unit !== 'NA' && metadata.unit !== countParams.unit) continue
      if (countParams.invoice && countParams.invoice !== 'NA' && metadata.invoice !== countParams.invoice) continue
      if (countParams.vin && countParams.vin !== 'NA' && metadata.vin !== countParams.vin) continue
      if (countParams.plate && countParams.plate !== 'NA' && metadata.plate !== countParams.plate) continue
      
      // Date filter
      if (dateFilter && metadata.date !== 'unknown') {
        if (!isDateInRange(metadata.date, dateFilter)) continue
      }
      
      // This file matches
      matchingCount++
      
      // Track per-company counts for admin users
      if (context.isAdmin) {
        companyCounts[metadata.company] = (companyCounts[metadata.company] || 0) + 1
      }
    }
    
    console.log(`Found ${matchingCount} matching ${countParams.docType} files`)
    
    // Prepare response with explicit typing
    interface DocumentCountResponse {
      success: boolean
      count: number
      docType: string
      bucket: string
      exceedsLimit: boolean
      searchParams: CountParams
      companyBreakdown?: Record<string, number>
      companiesFound?: number
      recommendation?: string
      suggestions?: string[]
    }
    
    const response: DocumentCountResponse = {
      success: true,
      count: matchingCount,
      docType: countParams.docType,
      bucket,
      exceedsLimit: matchingCount > 15,
      searchParams: countParams
    }
    
    // Add company breakdown for admin users
    if (context.isAdmin && Object.keys(companyCounts).length > 0) {
      response.companyBreakdown = companyCounts
      response.companiesFound = Object.keys(companyCounts).length
    }
    
    // Add recommendations if count exceeds limit
    if (matchingCount > 15) {
      response.recommendation = 'This query would return too many results. Consider:'
      response.suggestions = []
      
      if (!countParams.dateRange) {
        response.suggestions.push('Add a date range (e.g., "last week" or "this month")')
      } else {
        response.suggestions.push('Use a shorter date range')
      }
      
      if (!countParams.unit && !countParams.invoice) {
        response.suggestions.push('Specify a unit number or invoice number')
      }
      
      if (context.isAdmin && Object.keys(companyCounts).length > 1) {
        response.suggestions.push('Search one company at a time')
      }
    }
    
    return NextResponse.json(response)
    
  } catch (error) {
    console.error('Document count error:', error)
    return NextResponse.json(
      { success: false, error: 'Failed to count documents' },
      { status: 500 }
    )
  }
}