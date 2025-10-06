// app/api/ai/tools/search_dot_files/route.ts
import { NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

interface SearchParams {
  company?: string
  unit?: string
  vin?: string
  plate?: string
  dateRange?: string
  limit?: number
}

interface FileResult {
  url: string
  name: string
  date: string
  unit: string
  vin: string
  plate: string
  company: string
  documentType: string
  bucket: string
}

interface SearchResponse {
  success: boolean
  files: FileResult[]
  count: number
  totalMatches: number
  metadata: {
    searchParams: SearchParams
    dateRangeApplied: boolean
    truncated: boolean
    bucket: string
    message?: string
  }
}

function parseDateRange(dateRange?: string) {
  if (!dateRange) return null

  const now = new Date()
  const lower = dateRange.toLowerCase().trim()

  switch (lower) {
    case 'today': {
      const start = new Date(now.getFullYear(), now.getMonth(), now.getDate())
      const end = new Date(now)
      return { start, end }
    }
    case 'yesterday': {
      const start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1)
      const end = new Date(now.getFullYear(), now.getMonth(), now.getDate())
      return { start, end }
    }
    case 'this_week': {
      const day = now.getDay() || 7
      const start = new Date(now)
      start.setHours(0, 0, 0, 0)
      start.setDate(now.getDate() - day + 1)
      const end = new Date(now)
      return { start, end }
    }
    case 'last_week': {
      const day = now.getDay() || 7
      const end = new Date(now)
      end.setHours(0, 0, 0, 0)
      end.setDate(now.getDate() - day + 1)
      const start = new Date(end)
      start.setDate(end.getDate() - 7)
      return { start, end }
    }
    case 'this_month': {
      const start = new Date(now.getFullYear(), now.getMonth(), 1)
      const end = new Date(now)
      return { start, end }
    }
    case 'last_month': {
      const end = new Date(now)
      const start = new Date(now)
      start.setMonth(start.getMonth() - 1)
      return { start, end }
    }
    default:
      // Handle "September 2025" or "2025-09-01 to 2025-09-30" formats
      if (dateRange.includes(' to ')) {
        const [startStr, endStr] = dateRange.split(' to ')
        return {
          start: new Date(startStr),
          end: new Date(endStr)
        }
      }

      // Try to parse single month name + year
      const tryDate = new Date(dateRange)
      if (!isNaN(tryDate.getTime())) {
        const start = new Date(tryDate.getFullYear(), tryDate.getMonth(), 1)
        const end = new Date(tryDate.getFullYear(), tryDate.getMonth() + 1, 0, 23, 59, 59, 999)
        return { start, end }
      }

      return null
  }
}

function buildFileUrl(bucket: string, fileName: string) {
  // Files are stored at the root of the bucket
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!
  const baseUrl = supabaseUrl.replace('/project', '')
  return `${baseUrl}/storage/v1/object/public/${bucket}/${encodeURIComponent(fileName)}`
}

function parseFileName(fileName: string) {
  // Extract metadata from filename
  const companyMatch = fileName.match(/^([^_]+)__/)
  const unitMatch = fileName.match(/__U-([^_]+)/i)
  const vinMatch = fileName.match(/__V-([^_]+)/i)
  const plateMatch = fileName.match(/__P-([^.]+)/i)
  const dateMatch = fileName.match(/__D-(\d{8})/)
  const invoiceMatch = fileName.match(/__I-([^_]+)/i)
  
  return {
    company: companyMatch ? companyMatch[1] : null,
    unit: unitMatch ? unitMatch[1] : 'NA',
    vin: vinMatch ? vinMatch[1] : 'NA',
    plate: plateMatch ? plateMatch[1] : 'NA',
    date: dateMatch ? dateMatch[1] : null,
    invoice: invoiceMatch ? invoiceMatch[1] : 'NA'
  }
}

function matchesCompany(fileName: string, company: string) {
  // Company name should be at the start of the filename
  return fileName.toLowerCase().startsWith(company.toLowerCase() + '__')
}

function matchesUnit(fileName: string, unit?: string) {
  if (!unit || unit === 'NA') return true
  const metadata = parseFileName(fileName)
  return metadata.unit.toLowerCase() === unit.toLowerCase()
}

function matchesVin(fileName: string, vin?: string) {
  if (!vin || vin === 'NA') return true
  const metadata = parseFileName(fileName)
  // Allow partial VIN matching (last 6 chars)
  if (vin.length <= 8) {
    return metadata.vin.toLowerCase().endsWith(vin.toLowerCase())
  }
  return metadata.vin.toLowerCase().includes(vin.toLowerCase())
}

function matchesPlate(fileName: string, plate?: string) {
  if (!plate || plate === 'NA') return true
  const metadata = parseFileName(fileName)
  return metadata.plate.toLowerCase().includes(plate.toLowerCase())
}

function inDateRange(fileName: string, range: { start: Date, end: Date } | null) {
  if (!range) return true
  
  const metadata = parseFileName(fileName)
  if (!metadata.date || metadata.date.length !== 8) return true
  
  const year = parseInt(metadata.date.substring(4, 8))
  const month = parseInt(metadata.date.substring(0, 2))
  const day = parseInt(metadata.date.substring(2, 4))
  
  if (month < 1 || month > 12 || day < 1 || day > 31) return true
  
  const fileDate = new Date(year, month - 1, day)
  return fileDate >= range.start && fileDate <= range.end
}

export async function POST(req: Request) {
  try {
    const body = await req.json()
    const { company, unit, vin, plate, dateRange, limit = 15, context } = body
    
    console.log('=== SEARCH DOT FILES ===')
    console.log('Search params:', { company, unit, vin, plate, dateRange, limit })
    console.log('Context:', context)
    
    const dateFilter = parseDateRange(dateRange)

    if (!company) {
      return NextResponse.json(
        { success: false, error: 'Company name is required' },
        { status: 400 }
      )
    }

    // List all files in DOT bucket (files are at root, not in folders)
    const bucket = 'DOT'
    const { data: files, error } = await supabase.storage
      .from(bucket)
      .list('', { limit: 1000 }) // List files at root
    
    if (error) {
      console.error('Supabase list error:', error)
      return NextResponse.json(
        { success: false, error: 'Storage list failed' },
        { status: 500 }
      )
    }

    // Filter files that match criteria
    const matchingFiles = (files || [])
      .map(f => ({ ...f, name: f.name.trim() })) // Trim any spaces from filenames
      .filter(f => f.name.endsWith('.pdf'))
      .filter(f => f.name.toLowerCase().includes('__dot__')) // Must have DOT marker
      .filter(f => matchesCompany(f.name, company))
      .filter(f => matchesUnit(f.name, unit))
      .filter(f => matchesVin(f.name, vin))
      .filter(f => matchesPlate(f.name, plate))
      .filter(f => inDateRange(f.name, dateFilter))

    // Sort by date (newest first) - fixed date parsing
    matchingFiles.sort((a, b) => {
      const aDate = parseFileName(a.name).date || '00000000'
      const bDate = parseFileName(b.name).date || '00000000'
      // Convert MMDDYYYY to YYYYMMDD for proper sorting
      const aSort = aDate.length === 8 ? aDate.slice(4,8) + aDate.slice(0,4) : aDate
      const bSort = bDate.length === 8 ? bDate.slice(4,8) + bDate.slice(0,4) : bDate
      return bSort.localeCompare(aSort)
    })

    // Limit results
    const sliced = matchingFiles.slice(0, limit)

    // Build response with proper URLs
    const filesWithUrls: FileResult[] = sliced.map(f => {
      const metadata = parseFileName(f.name)
      const url = buildFileUrl(bucket, f.name)
      
      const formattedDate = metadata.date 
        ? `${metadata.date.slice(0,2)}/${metadata.date.slice(2,4)}/${metadata.date.slice(4,8)}`
        : 'Unknown'

      return {
        url,
        name: f.name,
        date: formattedDate,
        unit: metadata.unit,
        vin: metadata.vin,
        plate: metadata.plate,
        company: metadata.company || company,
        documentType: 'DOT Inspection',
        bucket
      }
    })

    const response: SearchResponse = {
      success: true,
      files: filesWithUrls,
      count: filesWithUrls.length,
      totalMatches: matchingFiles.length,
      metadata: {
        searchParams: { company, unit, vin, plate, dateRange, limit },
        dateRangeApplied: !!dateFilter,
        truncated: matchingFiles.length > limit,
        bucket: 'DOT'
      }
    }

    // Add message if truncated
    if (matchingFiles.length > limit) {
      response.metadata.message = `Showing ${limit} of ${matchingFiles.length} matching files. Refine your search to see different results.`
    }

    console.log(`Found ${matchingFiles.length} matching files, returning ${filesWithUrls.length}`)

    return NextResponse.json(response)

  } catch (error) {
    console.error('DOT search error:', error)
    return NextResponse.json(
      { success: false, error: 'Search failed' },
      { status: 500 }
    )
  }
}