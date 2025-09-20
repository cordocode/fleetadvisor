import { NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'

// Use service role key for storage operations
const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

export async function POST(request: Request) {
  try {
    const { company, unitNumber, searchParams } = await request.json()
    
    console.log('Searching for files:', { company, unitNumber, searchParams })
    
    // List all files in the DOT bucket
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
    
    console.log('All files in bucket:', files)
    
    // Filter files based on search parameters
    const matchingFiles = files?.filter(file => {
      // File must be for this company
      if (!file.name.startsWith(company)) return false
      
      // Check if it's a DOT file (has __dot__ after company name)
      const isDotFile = file.name.includes(`${company}__dot__`)
      
      // If searchParams provided, use them; otherwise fall back to unitNumber
      if (searchParams) {
        // Build search patterns based on what was provided
        if (searchParams.unit) {
          return isDotFile && file.name.includes(`__U-${searchParams.unit}__`)
        }
        if (searchParams.invoice) {
          return file.name.includes(`__I-${searchParams.invoice}__`)
        }
        if (searchParams.vin) {
          return file.name.includes(`__V-${searchParams.vin}__`)
        }
        if (searchParams.plate && searchParams.plate !== 'NA') {
          return file.name.includes(`__P-${searchParams.plate}`)
        }
      } else if (unitNumber && unitNumber !== 'NOT_FOUND') {
        // Backward compatibility: search by unit number for DOT files only
        return isDotFile && file.name.includes(`__U-${unitNumber}__`)
      }
      
      return false
    }) || []
    
    console.log('Matching files:', matchingFiles)
    
    // Sort by date (newest first) - date is in filename as D-MMDDYYYY format
    const sortedFiles = matchingFiles.sort((a, b) => {
      // Extract date in D-MMDDYYYY format and convert to sortable format
      const dateA = a.name.match(/D-(\d{8})/)?.[1] || '0'
      const dateB = b.name.match(/D-(\d{8})/)?.[1] || '0'
      
      // Convert MMDDYYYY to YYYYMMDD for proper sorting
      const sortableA = dateA.length === 8 ? 
        dateA.substring(4, 8) + dateA.substring(0, 2) + dateA.substring(2, 4) : dateA
      const sortableB = dateB.length === 8 ? 
        dateB.substring(4, 8) + dateB.substring(0, 2) + dateB.substring(2, 4) : dateB
      
      return sortableB.localeCompare(sortableA)
    })
    
    // Get public URLs for the files and extract metadata
    const filesWithUrls = sortedFiles.map(file => {
      const { data } = supabase
        .storage
        .from('DOT')
        .getPublicUrl(file.name)
      
      // Extract all metadata from filename
      const invoiceMatch = file.name.match(/I-(\d+)__/)
      const unitMatch = file.name.match(/U-([^_]+)__/)
      const vinMatch = file.name.match(/V-([^_]+)__/)
      const plateMatch = file.name.match(/P-([^_]+)/)
      const dateMatch = file.name.match(/D-(\d{8})/)
      const isDot = file.name.includes('__dot__')
      
      // Format date from MMDDYYYY to MM/DD/YYYY for display
      let formattedDate = 'unknown'
      if (dateMatch && dateMatch[1].length === 8) {
        const rawDate = dateMatch[1]
        formattedDate = `${rawDate.substring(0, 2)}/${rawDate.substring(2, 4)}/${rawDate.substring(4, 8)}`
      }
      
      return {
        name: file.name,
        url: data.publicUrl,
        date: formattedDate,
        invoice: invoiceMatch ? invoiceMatch[1] : 'unknown',
        unit: unitMatch ? unitMatch[1] : 'unknown',
        vin: vinMatch ? vinMatch[1] : 'unknown',
        plate: plateMatch ? plateMatch[1] : 'unknown',
        isDot,
        rawDate: dateMatch ? dateMatch[1] : 'unknown'
      }
    })
    
    return NextResponse.json({ 
      success: true,
      files: filesWithUrls,
      count: filesWithUrls.length
    })
    
  } catch (error) {
    console.error('Retrieve error:', error)
    return NextResponse.json(
      { success: false, error: 'Failed to retrieve files' },
      { status: 500 }
    )
  }
}