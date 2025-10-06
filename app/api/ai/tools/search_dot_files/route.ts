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

function buildFileUrl(bucket: string, path: string) {
  const publicUrl = `${process.env.NEXT_PUBLIC_SUPABASE_URL!.replace('/project', '')}/storage/v1/object/public/${bucket}/${encodeURIComponent(path)}`
  return publicUrl
}

function matchesUnit(name: string, unit?: string) {
  if (!unit) return true
  const u = unit.toString().trim()
  return new RegExp(`\\b(U-|unit[-_ ]?)${u}\\b`, 'i').test(name)
}

function matchesVin(name: string, vin?: string) {
  if (!vin) return true
  const v = vin.trim()
  // allow end-of-vin matching (last 6)
  if (v.length <= 8) {
    return new RegExp(`\\b(V-|vin[-_ ]?)?[A-HJ-NPR-Z0-9]{9}${v}\\b`, 'i').test(name) || new RegExp(`${v}\\b`, 'i').test(name)
  }
  return name.toLowerCase().includes(v.toLowerCase())
}

function matchesPlate(name: string, plate?: string) {
  if (!plate) return true
  const p = plate.trim()
  return new RegExp(`\\b(P-|plate[-_ ]?)?${p}\\b`, 'i').test(name) || name.toLowerCase().includes(p.toLowerCase())
}

function inDateRange(name: string, range: { start: Date, end: Date } | null) {
  if (!range) return true
  // Expecting __D-YYYYMMDD in filename; fallback to any date-like pattern
  const d = name.match(/__D-(\d{8})/) || name.match(/(\d{4}[-_/]\d{2}[-_/]\d{2})/)
  if (!d) return true

  let fileDate: Date | null = null
  if (d[1] && /^\d{8}$/.test(d[1])) {
    const y = parseInt(d[1].slice(0, 4), 10)
    const m = parseInt(d[1].slice(4, 6), 10) - 1
    const day = parseInt(d[1].slice(6, 8), 10)
    fileDate = new Date(y, m, day)
  } else if (d[1]) {
    fileDate = new Date(d[1])
  }

  if (!fileDate) return true
  return fileDate >= range.start && fileDate <= range.end
}

export async function POST(req: Request) {
  try {
    const body = await req.json()
    const { company, unit, vin, plate, dateRange, limit = 15 } = body
    
    const dateFilter = parseDateRange(dateRange)

    const filters: SearchParams = {
      company,
      unit,
      vin,
      plate,
      dateRange,
      limit
    }

    if (!company) {
      return NextResponse.json(
        { success: false, error: 'Missing company' },
        { status: 400 }
      )
    }

    // List objects from DOT bucket
    const bucket = 'DOT'
    const { data, error } = await supabase.storage.from(bucket).list('', { limit: 1000 })
    if (error) {
      console.error('Supabase list error:', error.message)
      return NextResponse.json(
        { success: false, error: 'Storage list failed' },
        { status: 500 }
      )
    }

    const entries = data || []
    const matchingFiles = entries
      .filter((f) => f.name.toLowerCase().includes('__dot__'))
      .filter((f) => matchesUnit(f.name, unit))
      .filter((f) => matchesVin(f.name, vin))
      .filter((f) => matchesPlate(f.name, plate))
      .filter((f) => inDateRange(f.name, dateFilter))

    // sort by name desc (often includes date), newest first
    matchingFiles.sort((a, b) => b.name.localeCompare(a.name))

    const sliced = matchingFiles.slice(0, limit)

    const filesWithUrls: FileResult[] = sliced.map((f) => {
      const path = `${company}/${f.name}`
      const url = buildFileUrl(bucket, path)
      const docType = 'DOT Inspection'
      // Extract basic metadata
      const unitMatch = f.name.match(/__U-(\w+)/i)
      const vinMatch = f.name.match(/__V-([A-HJ-NPR-Z0-9]+)/i)
      const plateMatch = f.name.match(/__P-([\w-]+)/i)
      const dateMatch = f.name.match(/__D-(\d{8})/)

      const date = dateMatch ? `${dateMatch[1].slice(0,4)}-${dateMatch[1].slice(4,6)}-${dateMatch[1].slice(6,8)}` : 'Unknown'

      return {
        url,
        name: f.name,
        date,
        unit: unitMatch?.[1] ?? 'NA',
        vin: vinMatch?.[1] ?? 'NA',
        plate: plateMatch?.[1] ?? 'NA',
        company,
        documentType: docType,
        bucket
      }
    })

    const response: SearchResponse = {
      success: true,
      files: filesWithUrls,
      count: filesWithUrls.length,
      totalMatches: matchingFiles.length,
      metadata: {
        searchParams: filters,
        dateRangeApplied: !!dateFilter,
        truncated: matchingFiles.length > limit,
        bucket: 'DOT'
      }
    }

    // Add warning if results were truncated
    if (matchingFiles.length > limit) {
      response.metadata.message = `Showing ${limit} of ${matchingFiles.length} matching files. Refine your search to see different results.`
    }

    console.log(`Returning ${filesWithUrls.length} DOT files`)

    return NextResponse.json(response)

  } catch (error) {
    console.error('DOT search error:', error)
    return NextResponse.json(
      { success: false, error: 'Search failed' },
      { status: 500 }
    )
  }
}