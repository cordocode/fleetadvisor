import { NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'

// Use service role key for storage operations
const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

export async function POST(request: Request) {
  try {
    const { company, unitNumber } = await request.json()
    
    console.log('Searching for files:', { company, unitNumber })
    
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
    
    // Filter files for this company and unit
    // NEW PATTERN: companyname__dot__I-{invoice}__U-{unit}__V-{vin}__D-{date}__P-{plate}.pdf
    // We only want DOT inspections, so we look for files with __dot__ after company name
    const matchingFiles = files?.filter(file => {
      const dotPattern = `${company}__dot__I-`
      const unitPattern = `__U-${unitNumber}__`
      
      // Check if it's a DOT file for this company and has the right unit number
      return file.name.startsWith(dotPattern) && file.name.includes(unitPattern)
    }) || []
    
    console.log('Matching DOT files:', matchingFiles)
    
    // Sort by date (newest first) - date is in filename as D-MMDDYYYY format now
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
      
      // Extract invoice number from filename
      const invoiceMatch = file.name.match(/I-(\d+)__/)
      const dateMatch = file.name.match(/D-(\d{8})/)
      
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