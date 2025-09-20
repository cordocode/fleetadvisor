import { NextRequest, NextResponse } from 'next/server';
// @ts-expect-error - pdf-parse-fork doesn't have TypeScript types
import pdf from 'pdf-parse-fork';
import OpenAI from 'openai';

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

// Suppress the Buffer deprecation warning for this specific module
const originalEmitWarning = process.emitWarning;
process.emitWarning = (warning: string | Error, ...args: unknown[]) => {
  if (typeof warning === 'string' && warning.includes('Buffer() is deprecated')) {
    return;
  }
  originalEmitWarning.apply(process, [warning, ...args] as Parameters<typeof process.emitWarning>);
};

export async function POST(request: NextRequest) {
  console.log('=== Extract Invoice Metadata API Called ===');
  
  try {
    const formData = await request.formData();
    const file = formData.get('file') as File | null;
    
    if (!file) {
      return NextResponse.json(
        { success: false, error: 'No file provided' },
        { status: 400 }
      );
    }

    // Convert File to Buffer for pdf-parse-fork
    const bytes = await file.arrayBuffer();
    const buffer = Buffer.from(bytes);
    
    // Extract text from PDF
    let pdfData;
    try {
      pdfData = await pdf(buffer);
    } catch (pdfError: unknown) {
      console.error('PDF parsing failed:', pdfError);
      return NextResponse.json(
        { 
          success: false, 
          error: 'Failed to parse PDF',
          details: pdfError instanceof Error ? pdfError.message : 'Unknown error'
        },
        { status: 500 }
      );
    }
    
    const text = pdfData.text;
    
    // Use OpenAI to extract metadata
    const completion = await openai.chat.completions.create({
      model: "gpt-3.5-turbo",
      messages: [
        {
          role: "system",
          content: `Extract vehicle information from invoice text. Return JSON with exactly these keys:
          - unit: The unit number (uppercase, no spaces) or "NA" if not found
          - vin: The VIN number (17 characters, uppercase, no spaces) or "NA" if not found  
          - plate: The plate/license number (uppercase, no spaces) or "NA" if not found
          
          Remove all whitespace and convert to uppercase. Return ONLY valid JSON.`
        },
        {
          role: "user",
          content: text
        }
      ],
      temperature: 0,
      response_format: { type: "json_object" }
    });
    
    const metadata = JSON.parse(completion.choices[0].message.content || '{}');
    
    // Ensure all fields exist and are uppercase with no spaces
    const cleanMetadata = {
      unit: (metadata.unit || 'NA').toUpperCase().replace(/\s+/g, ''),
      vin: (metadata.vin || 'NA').toUpperCase().replace(/\s+/g, ''),
      plate: (metadata.plate || 'NA').toUpperCase().replace(/\s+/g, '')
    };
    
    console.log('Extracted metadata:', cleanMetadata);
    
    return NextResponse.json({
      success: true,
      metadata: cleanMetadata
    });

  } catch (error: unknown) {
    console.error('Error extracting metadata:', error);
    return NextResponse.json(
      { 
        success: false, 
        error: 'Failed to extract metadata',
        details: error instanceof Error ? error.message : 'Unknown error'
      },
      { status: 500 }
    );
  }
}

// Health check endpoint
export async function GET() {
  return NextResponse.json({ 
    status: 'healthy',
    endpoint: '/api/extract-invoice-metadata',
    method: 'POST',
    expects: 'multipart/form-data with file field'
  });
}