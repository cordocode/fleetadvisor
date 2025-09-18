import { NextRequest, NextResponse } from 'next/server';

// This will work in serverless - no filesystem or canvas dependencies
const pdf = require('pdf-parse-fork');

export async function POST(request: NextRequest) {
  console.log('=== DOT Check API Called ===');
  console.log('Time:', new Date().toISOString());
  
  try {
    // Parse the incoming form data
    const formData = await request.formData();
    const file = formData.get('file') as File | null;
    
    if (!file) {
      console.log('ERROR: No file provided in request');
      return NextResponse.json(
        { 
          success: false, 
          error: 'No file provided',
          debug: 'File field missing from form data'
        },
        { status: 400 }
      );
    }

    console.log('File received:', {
      name: file.name,
      size: file.size,
      type: file.type
    });

    // Convert File to Buffer for pdf-parse-fork
    const bytes = await file.arrayBuffer();
    const buffer = Buffer.from(bytes);
    
    console.log('Buffer created, size:', buffer.length);

    // Extract text from PDF
    let pdfData;
    try {
      pdfData = await pdf(buffer);
      console.log('PDF parsed successfully');
      console.log('Number of pages:', pdfData.numpages);
      console.log('Text length:', pdfData.text.length);
    } catch (pdfError: any) {
      console.error('PDF parsing failed:', pdfError);
      return NextResponse.json(
        { 
          success: false, 
          error: 'Failed to parse PDF',
          details: pdfError.message
        },
        { status: 500 }
      );
    }

    // Normalize the extracted text for robust matching
    const normalizedText = pdfData.text
      .toLowerCase()
      .replace(/\s+/g, ' ')           // Collapse all whitespace to single spaces
      .replace(/[^\x20-\x7E]/g, '')   // Remove non-ASCII characters (OCR artifacts)
      .trim();
    
    console.log('Normalized text sample (first 500 chars):');
    console.log(normalizedText.substring(0, 500));

    // Check for DOT pattern with flexible spacing
    // Looking for: "dot pass : checked" with variable spacing
    const dotPassPattern = /dot\s+pass\s*:\s*checked/;
    const isDotInspection = dotPassPattern.test(normalizedText);
    
    console.log('DOT pattern check:', isDotInspection ? 'FOUND' : 'NOT FOUND');
    
    // Additional debug - search for related terms
    const debugInfo = {
      containsDot: normalizedText.includes('dot'),
      containsPass: normalizedText.includes('pass'),
      containsChecked: normalizedText.includes('checked'),
      containsInspection: normalizedText.includes('inspection'),
      textLength: normalizedText.length
    };
    
    console.log('Debug info:', debugInfo);

    // Return result
    return NextResponse.json({
      success: true,
      isDotInspection,
      debug: {
        ...debugInfo,
        sampleText: normalizedText.substring(0, 200) // First 200 chars for debugging
      }
    });

  } catch (error: any) {
    console.error('Unexpected error in DOT check:', error);
    return NextResponse.json(
      { 
        success: false, 
        error: 'Internal server error',
        details: error.message 
      },
      { status: 500 }
    );
  }
}

// Also support GET for health check
export async function GET() {
  return NextResponse.json({ 
    status: 'healthy',
    endpoint: '/api/check-invoice-for-dot',
    method: 'POST',
    expects: 'multipart/form-data with file field',
    timestamp: new Date().toISOString()
  });
}