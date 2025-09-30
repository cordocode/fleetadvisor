import { NextResponse } from 'next/server'
import OpenAI from 'openai'

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
})

export async function POST(request: Request) {
  try {
    const { message } = await request.json()
    
    console.log('Admin parsing request:', { message })
    
    // Use GPT-4 for more sophisticated parsing
    const completion = await openai.chat.completions.create({
      model: "gpt-4-turbo-preview",
      messages: [
        {
          role: "system",
          content: `You are an advanced search query parser for a fleet management system. Extract ALL relevant search parameters from user requests.
          
          Extract ANY of the following:
          - company: Company name (e.g., "sturgeon", "rocky-mountain-transport"). Use kebab-case format.
          - dateRange: Can be:
            * "last_week" - previous 7 days
            * "this_week" - current week
            * "last_month" - previous 30 days  
            * "this_month" - current month
            * { start: "YYYY-MM-DD", end: "YYYY-MM-DD" } - specific range
            * { month: number, year: number } - specific month
          - docType: "dot" | "invoice" | "all" (default: "all")
          - unit: Unit number (uppercase, no spaces)
          - invoice: Invoice number
          - vin: VIN number (17 characters)
          - plate: License plate number (uppercase, no spaces)
          
          IMPORTANT DATE EXTRACTION:
          - "last week" → "last_week"
          - "this week" → "this_week"
          - "last month" → "last_month"
          - "this month" → "this_month"
          - "September" or "Sep" → { month: 9, year: 2025 }
          - "between Sept 1 and Sept 7" → { start: "2025-09-01", end: "2025-09-07" }
          
          IMPORTANT COMPANY NAME EXTRACTION:
          - Convert to kebab-case: "Rocky Mountain" → "rocky-mountain"
          - "Sturgeon Transport" → "sturgeon-transport"
          - If user says just "Sturgeon" or "Rocky", use "sturgeon" or "rocky"
          
          DOCUMENT TYPE EXTRACTION:
          - "DOT inspections" → "dot"
          - "invoices" → "invoice"
          - If not specified → "all"
          
          Return a JSON object with these keys (all optional except searchType):
          {
            "company": string | null,
            "dateRange": string | object | null,
            "docType": "dot" | "invoice" | "all",
            "unit": string | null,
            "invoice": string | null,
            "vin": string | null,
            "plate": string | null,
            "searchType": "simple" | "complex",
            "isAmbiguous": boolean,
            "naturalLanguageSummary": string
          }
          
          searchType should be:
          - "simple" if only one parameter specified
          - "complex" if multiple parameters or date ranges involved
          
          naturalLanguageSummary should be a human-readable summary like:
          "Searching for DOT inspections for Sturgeon from last week"
          
          Examples:
          "All Sturgeon DOTs from last week" → 
          {
            "company": "sturgeon",
            "dateRange": "last_week",
            "docType": "dot",
            "searchType": "complex",
            "naturalLanguageSummary": "Searching for DOT inspections for Sturgeon from last week"
          }
          
          "Unit 112 invoices in September" →
          {
            "unit": "112",
            "dateRange": { "month": 9, "year": 2025 },
            "docType": "invoice",
            "searchType": "complex",
            "naturalLanguageSummary": "Searching for invoices for Unit 112 from September 2025"
          }
          
          "Show me Rocky Mountain Transport files" →
          {
            "company": "rocky-mountain-transport",
            "docType": "all",
            "searchType": "simple",
            "naturalLanguageSummary": "Searching for all files for Rocky Mountain Transport"
          }
          
          Always return valid JSON.`
        },
        {
          role: "user",
          content: message
        }
      ],
      temperature: 0,
      response_format: { type: "json_object" }
    })
    
    const searchParams = JSON.parse(completion.choices[0].message.content || '{}')
    
    // Ensure all fields exist with defaults
    const result = {
      company: searchParams.company || null,
      dateRange: searchParams.dateRange || null,
      docType: searchParams.docType || 'all',
      unit: searchParams.unit || null,
      invoice: searchParams.invoice || null,
      vin: searchParams.vin || null,
      plate: searchParams.plate || null,
      searchType: searchParams.searchType || 'simple',
      isAmbiguous: searchParams.isAmbiguous || false,
      naturalLanguageSummary: searchParams.naturalLanguageSummary || 'Searching files...'
    }
    
    console.log('Admin parsed search parameters:', result)
    
    return NextResponse.json({ 
      success: true,
      searchParams: result
    })
    
  } catch (error) {
    console.error('Admin parse error:', error)
    return NextResponse.json(
      { success: false, error: 'Failed to parse request' },
      { status: 500 }
    )
  }
}