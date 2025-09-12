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
          content: `You are a helper that extracts unit numbers from user requests about DOT inspections.
          
          Extract ONLY the unit number from the request. 
          - If the user says "unit 112" return "112"
          - If the user says "truck 45" return "45"
          - If the user says "vehicle ABC123" return "ABC123"
          - If no unit number is found, return "NOT_FOUND"
          
          Return ONLY the unit number or "NOT_FOUND", nothing else.`
        },
        {
          role: "user",
          content: message
        }
      ],
      temperature: 0
    })
    
    const unitNumber = completion.choices[0].message.content?.trim() || 'NOT_FOUND'
    
    console.log('Extracted unit number:', unitNumber)
    
    return NextResponse.json({ 
      success: true,
      unitNumber,
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