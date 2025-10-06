// app/api/migrations/rename-companies/route.ts
import { NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

// Company name corrections mapping
const COMPANY_CORRECTIONS: Record<string, string> = {
  'amazon-logistics': 'amazon-logistics,-inc.',
  'advent-air-conditioning': 'advent-air-conditioning,-inc.',
  'andys-sprinkler-drainage-and-lighting': "andy's-sprinkler,-drainage-and-lighting",
  'ardent-traffic-services-inc': 'ardent-traffic-services,-inc',
  'bridge33-capital-belmar': 'bridge33-capital-(belmar)',
  'deandrea-coring-and-sawing-inc': 'deandrea-coring-and-sawing,-inc.',
  'durable-specialties-inc': 'durable-specialties,-inc',
  'nuvolt-group-north-america-llc': 'nuvolt-group-north-america,-llc',
  'parker-personal-care-homes-inc': 'parker-personal-care-homes,-inc.',
  'phrg-intermediate-llc-dfw': 'phrg-intermediate,-llc-dfw',
  'rk-mechanical-llc': 'rk-mechanical,-llc.',
  'site-planning-site-development-inc-spsd': 'site-planning-site-development,-inc.-spsd',
  'your-neighbors-moving-storage-llc': 'your-neighbors-moving-&-storage,-llc'
}

interface RenameResult {
  bucket: string
  oldName: string
  newName: string
  success: boolean
  error?: string
}

function extractCompanyFromFilename(filename: string): string | null {
  const match = filename.match(/^([^_]+)__/)
  return match ? match[1] : null
}

function needsCorrection(companyName: string): string | null {
  // Normalize for comparison (remove special chars to match keys)
  const normalized = companyName
    .toLowerCase()
    .replace(/[',.-]/g, '-')
    .replace(/&/g, 'and')
    .replace(/\(|\)/g, '')
    .replace(/--+/g, '-')
    .replace(/^-|-$/g, '')
  
  return COMPANY_CORRECTIONS[normalized] || null
}

function renameCompanyInFilename(filename: string, oldCompany: string, newCompany: string): string {
  return filename.replace(new RegExp(`^${oldCompany}__`, 'i'), `${newCompany}__`)
}

async function processFiles(bucket: string, dryRun: boolean = true): Promise<RenameResult[]> {
  const results: RenameResult[] = []
  
  console.log(`\n=== Processing ${bucket} bucket (${dryRun ? 'DRY RUN' : 'LIVE'}) ===`)
  
  // List all files
  const { data: files, error: listError } = await supabase.storage
    .from(bucket)
    .list('', { limit: 10000 })
  
  if (listError) {
    console.error(`Error listing ${bucket}:`, listError)
    return results
  }
  
  console.log(`Found ${files?.length || 0} files in ${bucket}`)
  
  for (const file of files || []) {
    const filename = file.name.trim()
    
    if (!filename.endsWith('.pdf')) continue
    
    // Extract company name from filename
    const companyName = extractCompanyFromFilename(filename)
    
    if (!companyName) {
      console.log(`⚠️  Could not extract company from: ${filename}`)
      continue
    }
    
    // Check if this company needs correction
    const correctedName = needsCorrection(companyName)
    
    if (!correctedName) {
      // No correction needed
      continue
    }
    
    // Generate new filename
    const newFilename = renameCompanyInFilename(filename, companyName, correctedName)
    
    console.log(`\n📝 Found file to rename:`)
    console.log(`   Old: ${filename}`)
    console.log(`   New: ${newFilename}`)
    console.log(`   Company: ${companyName} → ${correctedName}`)
    
    if (dryRun) {
      results.push({
        bucket,
        oldName: filename,
        newName: newFilename,
        success: true
      })
      continue
    }
    
    // LIVE MODE: Actually perform the rename
    try {
      // Step 1: Copy file to new name
      const { data: fileData, error: downloadError } = await supabase.storage
        .from(bucket)
        .download(filename)
      
      if (downloadError) {
        throw new Error(`Download failed: ${downloadError.message}`)
      }
      
      // Step 2: Upload with new name
      const { error: uploadError } = await supabase.storage
        .from(bucket)
        .upload(newFilename, fileData, {
          contentType: 'application/pdf',
          upsert: false
        })
      
      if (uploadError) {
        throw new Error(`Upload failed: ${uploadError.message}`)
      }
      
      // Step 3: Delete old file
      const { error: deleteError } = await supabase.storage
        .from(bucket)
        .remove([filename])
      
      if (deleteError) {
        throw new Error(`Delete failed: ${deleteError.message}`)
      }
      
      console.log(`✅ Successfully renamed`)
      
      results.push({
        bucket,
        oldName: filename,
        newName: newFilename,
        success: true
      })
      
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : 'Unknown error'
      console.error(`❌ Failed to rename: ${errorMsg}`)
      
      results.push({
        bucket,
        oldName: filename,
        newName: newFilename,
        success: false,
        error: errorMsg
      })
    }
  }
  
  return results
}

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url)
    const mode = searchParams.get('mode') || 'dry-run'
    const bucket = searchParams.get('bucket') || 'both'
    
    const dryRun = mode === 'dry-run'
    
    console.log('\n' + '='.repeat(60))
    console.log(`COMPANY NAME MIGRATION - ${dryRun ? 'DRY RUN MODE' : '⚠️  LIVE MODE ⚠️'}`)
    console.log('='.repeat(60))
    
    const allResults: RenameResult[] = []
    
    // Process DOT bucket
    if (bucket === 'both' || bucket === 'DOT') {
      const dotResults = await processFiles('DOT', dryRun)
      allResults.push(...dotResults)
    }
    
    // Process INVOICE bucket
    if (bucket === 'both' || bucket === 'INVOICE') {
      const invoiceResults = await processFiles('INVOICE', dryRun)
      allResults.push(...invoiceResults)
    }
    
    // Summary
    const successful = allResults.filter(r => r.success).length
    const failed = allResults.filter(r => !r.success).length
    
    console.log('\n' + '='.repeat(60))
    console.log('SUMMARY')
    console.log('='.repeat(60))
    console.log(`Total files ${dryRun ? 'to rename' : 'renamed'}: ${successful}`)
    if (failed > 0) {
      console.log(`Failed: ${failed}`)
    }
    console.log('='.repeat(60))
    
    return NextResponse.json({
      mode: dryRun ? 'dry-run' : 'live',
      bucket,
      summary: {
        total: allResults.length,
        successful,
        failed
      },
      results: allResults
    })
    
  } catch (error) {
    console.error('Migration error:', error)
    return NextResponse.json(
      { 
        success: false, 
        error: error instanceof Error ? error.message : 'Migration failed' 
      },
      { status: 500 }
    )
  }
}