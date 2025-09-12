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
    // Pattern: companyname__DOT__U-{unit}__V-{vin}__D-{date}.pdf
    const matchingFiles = files?.filter(file => {
      const pattern = `${company}__DOT__U-${unitNumber}__`
      return file.name.startsWith(pattern)
    }) || []
    
    console.log('Matching files:', matchingFiles)
    
    // Sort by date (newest first) - date is in filename as D-YYYYMMDD
    const sortedFiles = matchingFiles.sort((a, b) => {
      const dateA = a.name.match(/D-(\d{8})/)?.[1] || '0'
      const dateB = b.name.match(/D-(\d{8})/)?.[1] || '0'
      return dateB.localeCompare(dateA)
    })
    
    // Get public URLs for the files
    const filesWithUrls = sortedFiles.map(file => {
      const { data } = supabase
        .storage
        .from('DOT')
        .getPublicUrl(file.name)
      
      return {
        name: file.name,
        url: data.publicUrl,
        date: file.name.match(/D-(\d{8})/)?.[1] || 'unknown'
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