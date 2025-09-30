import { NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

// Helper function to parse date ranges
function parseDateRange(dateRange: any): { start: Date; end: Date } | null {
  const now = new Date()
  
  if (typeof dateRange === 'string') {
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
        start.setDate(start.getDate() - 30)
        return { start, end }
      }
      case 'this_month': {
        const start = new Date(now.getFullYear(), now.getMonth(), 1)
        const end = new Date(now)
        return { start, end }
      }
      default:
        return null
    }
  } else if (dateRange && typeof dateRange === 'object') {
    if (dateRange.start && dateRange.end) {
      return {
        start: new Date(dateRange.start),
        end: new Date(dateRange.end)
      }
    } else if (dateRange.month && dateRange.year) {
      const start = new Date(dateRange.year, dateRange.month - 1, 1)
      const end = new Date(dateRange.year, dateRange.month, 0)
      return { start, end }
    }
  }
  
  return null
}

// Helper function to check if file date is in range
function isDateInRange(fileDate: string, range: { start: Date; end: Date }): boolean {
  // fileDate format is MMDDYYYY
  if (fileDate.length !== 8) return false
  
  const month = parseInt(fileDate.substring(0, 2))
  const day = parseInt(fileDate.substring(2, 4))
  const year = parseInt(fileDate.substring(4, 8))
  
  const date = new Date(year, month - 1, day)
  
  return date >= range.start && date <= range.end
}

// Helper function to format company name for matching
function normalizeCompanyName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, '')
}

export async function POST(request: Request) {
  try {
    const { searchParams, userId } = await request.json()
    
    console.log('Admin retrieving files with params:', searchParams)
    
    // Verify user is admin
    const { data: profile } = await supabase
      .from('profiles')
      .select('is_admin')
      .eq('user_id', userId)
      .single()
    
    if (!profile?.is_admin) {
      return NextResponse.json(
        { success: false, error: 'Unauthorized: Admin access required' },
        { status: 403 }
      )
    }
    
    // List all files in DOT bucket (admin sees everything)
    const { data: files, error } = await supabase
      .storage
      .from('DOT')
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
    
    console.log(`Total files in bucket: ${files?.length || 0}`)
    
    // Parse date range if provided
    const dateFilter = searchParams.dateRange 
      ? parseDateRange(searchParams.dateRange) 
      : null
    
    // Filter files based on all search parameters
    const matchingFiles = files?.filter(file => {
      // Extract metadata from filename
      const fileName = file.name
      const companyMatch = fileName.match(/^([^_]+)__/)
      const invoiceMatch = fileName.match(/I-([^_]+)__/)
      const unitMatch = fileName.match(/U-([^_]+)__/)
      const vinMatch = fileName.match(/V-([^_]+)__/)
      const plateMatch = fileName.match(/P-([^.]+)/)
      const dateMatch = fileName.match(/D-(\d{8})/)
      const isDot = fileName.includes('__dot__')
      
      // Company filter (fuzzy match)
      if (searchParams.company) {
        const fileCompany = companyMatch ? companyMatch[1] : ''
        const normalizedFileCompany = normalizeCompanyName(fileCompany)
        const normalizedSearchCompany = normalizeCompanyName(searchParams.company)
        
        if (!normalizedFileCompany.includes(normalizedSearchCompany)) {
          return false
        }
      }
      
      // Date filter
      if (dateFilter && dateMatch) {
        if (!isDateInRange(dateMatch[1], dateFilter)) {
          return false
        }
      }
      
      // Document type filter
      if (searchParams.docType !== 'all') {
        if (searchParams.docType === 'dot' && !isDot) return false
        if (searchParams.docType === 'invoice' && isDot) return false
      }
      
      // Unit filter
      if (searchParams.unit) {
        if (!unitMatch || unitMatch[1] !== searchParams.unit) {
          return false
        }
      }
      
      // Invoice filter
      if (searchParams.invoice) {
        if (!invoiceMatch || invoiceMatch[1] !== searchParams.invoice) {
          return false
        }
      }
      
      // VIN filter
      if (searchParams.vin) {
        if (!vinMatch || vinMatch[1] !== searchParams.vin) {
          return false
        }
      }
      
      // Plate filter
      if (searchParams.plate && searchParams.plate !== 'NA') {
        if (!plateMatch || plateMatch[1] !== searchParams.plate) {
          return false
        }
      }
      
      return true
    }) || []
    
    console.log(`Matching files found: ${matchingFiles.length}`)
    
    // Sort by date (newest first)
    const sortedFiles = matchingFiles.sort((a, b) => {
      const dateA = a.name.match(/D-(\d{8})/)?.[1] || '0'
      const dateB = b.name.match(/D-(\d{8})/)?.[1] || '0'
      
      const sortableA = dateA.length === 8 ? 
        dateA.substring(4, 8) + dateA.substring(0, 2) + dateA.substring(2, 4) : dateA
      const sortableB = dateB.length === 8 ? 
        dateB.substring(4, 8) + dateB.substring(0, 2) + dateB.substring(2, 4) : dateB
      
      return sortableB.localeCompare(sortableA)
    })
    
    // Get public URLs and extract metadata
    const filesWithUrls = sortedFiles.map(file => {
      const { data } = supabase
        .storage
        .from('DOT')
        .getPublicUrl(file.name)
      
      const companyMatch = file.name.match(/^([^_]+)__/)
      const invoiceMatch = file.name.match(/I-([^_]+)__/)
      const unitMatch = file.name.match(/U-([^_]+)__/)
      const vinMatch = file.name.match(/V-([^_]+)__/)
      const plateMatch = file.name.match(/P-([^.]+)/)
      const dateMatch = file.name.match(/D-(\d{8})/)
      const isDot = file.name.includes('__dot__')
      
      let formattedDate = 'unknown'
      if (dateMatch && dateMatch[1].length === 8) {
        const rawDate = dateMatch[1]
        formattedDate = `${rawDate.substring(0, 2)}/${rawDate.substring(2, 4)}/${rawDate.substring(4, 8)}`
      }
      
      return {
        name: file.name,
        url: data.publicUrl,
        company: companyMatch ? companyMatch[1] : 'unknown',
        date: formattedDate,
        invoice: invoiceMatch ? invoiceMatch[1] : 'unknown',
        unit: unitMatch ? unitMatch[1] : 'unknown',
        vin: vinMatch ? vinMatch[1] : 'unknown',
        plate: plateMatch ? plateMatch[1] : 'unknown',
        isDot,
        documentType: isDot ? 'DOT Inspection' : 'Invoice',
        rawDate: dateMatch ? dateMatch[1] : 'unknown'
      }
    })
    
    // Gather metadata about the search
    const uniqueCompanies = [...new Set(filesWithUrls.map(f => f.company))]
    
    return NextResponse.json({ 
      success: true,
      files: filesWithUrls,
      count: filesWithUrls.length,
      metadata: {
        companiesSearched: uniqueCompanies,
        dateRangeApplied: !!dateFilter,
        docTypeFilter: searchParams.docType,
        searchParams: searchParams
      }
    })
    
  } catch (error) {
    console.error('Admin retrieve error:', error)
    return NextResponse.json(
      { success: false, error: 'Failed to retrieve files' },
      { status: 500 }
    )
  }
}