import { NextResponse } from 'next/server'
import OpenAI from 'openai'

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
})

export async function POST(request: Request) {
  try {
    const { message, company } = await request.json()
    
    console.log('Parsing request:', { message, company })
    
    const completion = await openai.chat.completions.create({
      model: "gpt-3.5-turbo",
      messages: [
        {
          role: "system",
          content: `You are a helper that extracts search parameters from user requests about DOT inspections and invoices.
          
          Extract ANY of the following from the request:
          - Unit number (e.g., "unit 112", "truck 45", "vehicle 8G00MVV")
          - Invoice number (e.g., "invoice 46270", "invoice #46294")
          - VIN (17-character vehicle identification number)
          - Plate/License number (e.g., "plate QZP268", "license ABC123")
          
          IMPORTANT: If the user provides just a number without context (like "12345" or "get me 46270"):
          - Set "ambiguous" to true
          - Put the number in "ambiguousValue"
          - Leave all specific fields as null
          
          Return a JSON object with these keys:
          - unit: the unit number if CLEARLY specified, otherwise null
          - invoice: the invoice number if CLEARLY specified, otherwise null
          - vin: the VIN if CLEARLY specified, otherwise null
          - plate: the plate number if CLEARLY specified, otherwise null
          - searchType: "unit" | "invoice" | "vin" | "plate" | "ambiguous" | "none"
          - ambiguous: true if a number/value was provided without clear context, otherwise false
          - ambiguousValue: the ambiguous number/value if ambiguous is true, otherwise null
          
          Examples:
          - "get unit 112" -> unit: "112", searchType: "unit", ambiguous: false
          - "invoice 46270" -> invoice: "46270", searchType: "invoice", ambiguous: false
          - "get me 12345" -> ambiguous: true, ambiguousValue: "12345", searchType: "ambiguous"
          - "find 46270" -> ambiguous: true, ambiguousValue: "46270", searchType: "ambiguous"
          
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
    
    // Ensure all fields exist
    const result = {
      unit: searchParams.unit || null,
      invoice: searchParams.invoice || null,
      vin: searchParams.vin || null,
      plate: searchParams.plate || null,
      searchType: searchParams.searchType || 'none',
      ambiguous: searchParams.ambiguous || false,
      ambiguousValue: searchParams.ambiguousValue || null
    }
    
    console.log('Extracted search parameters:', result)
    
    // For backward compatibility, also include unitNumber
    const unitNumber = result.unit || (result.ambiguous ? 'AMBIGUOUS' : 'NOT_FOUND')
    
    return NextResponse.json({ 
      success: true,
      unitNumber, // Keep for backward compatibility
      searchParams: result,
      company 
    })
    
  } catch (error) {
    console.error('Parse error:', error)
    return NextResponse.json(
      { success: false, error: 'Failed to parse request' },
      { status: 500 }
    )
  }
}