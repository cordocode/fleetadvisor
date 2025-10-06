// app/api/ai/tools/lookup_company_code/route.ts
import { NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

// Convert kebab-case to display name
function toDisplayName(companyName: string): string {
  if (companyName === 'fleet-advisor-ai-admin') {
    return 'Fleet Advisor Admin'
  }
  
  return companyName
    .split('-')
    .map(word => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ')
}

export async function POST(request: Request) {
  try {
    const { company, context } = await request.json()
    
    console.log('=== LOOKUP COMPANY CODE ===')
    console.log('Company:', company)
    console.log('Context:', context)
    
    // Validate company parameter
    if (!company) {
      return NextResponse.json({
        success: false,
        error: 'Company name is required',
        requiresClarification: true
      })
    }
    
    // For non-admin users, only allow looking up their own company code
    if (!context?.isAdmin && context?.userCompany) {
      if (company !== context.userCompany) {
        return NextResponse.json({
          success: false,
          error: `You can only look up the code for your company (${toDisplayName(context.userCompany)})`,
          restricted: true
        })
      }
    }
    
    // Look up the company code
    const { data: companyData, error } = await supabase
      .from('companies')
      .select('code, name')
      .eq('name', company)
      .single()
    
    if (error || !companyData) {
      console.log('Company not found:', company)
      return NextResponse.json({
        success: false,
        error: `Company "${company}" not found in the system`,
        notFound: true
      })
    }
    
    console.log(`Found code for ${company}: ${companyData.code}`)
    
    // Return the code
    return NextResponse.json({
      success: true,
      company: companyData.name,
      displayName: toDisplayName(companyData.name),
      code: companyData.code,
      message: `The access code for ${toDisplayName(companyData.name)} is ${companyData.code}`
    })
    
  } catch (error) {
    console.error('Company code lookup error:', error)
    return NextResponse.json(
      { success: false, error: 'Failed to look up company code' },
      { status: 500 }
    )
  }
}