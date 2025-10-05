import { NextRequest, NextResponse } from 'next/server';
// @ts-expect-error - pdf-parse-fork doesn't have TypeScript types
import pdf from 'pdf-parse-fork';

export async function POST(request: NextRequest) {
  console.log('=== DOT Check API Called ===');
  console.log('Time:', new Date().toISOString());
  
  try {
    // Parse the incoming form data
    const formData = await request.formData();
    const file = formData.get('file') as File | null;
    const emailBody = formData.get('emailBody') as string | null;
    
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
    console.log('Email body received:', emailBody ? `${emailBody.length} chars` : 'none');

    // Convert File to Buffer for pdf-parse-fork
    const bytes = await file.arrayBuffer();
    const buffer = Buffer.from(bytes);
    
    // Extract text from PDF
    let pdfData;
    try {
      pdfData = await pdf(buffer);
      console.log('PDF parsed successfully');
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

    // Normalize PDF text
    const normalizedPdfText = pdfData.text
      .toLowerCase()
      .replace(/\s+/g, ' ')
      .trim();
    
    // PRIMARY CHECK: ONLY look for "DOT PASS: checked" in the PDF
    const dotPassCheckedPattern = /dot\s+pass\s*:\s*checked/;
    const isDotPassChecked = dotPassCheckedPattern.test(normalizedPdfText);
    
    console.log('PDF CHECK - DOT PASS: checked?', isDotPassChecked ? 'YES' : 'NO');
    
    let isDotInspection = isDotPassChecked;
    let detectionMethod = isDotPassChecked ? 'pdf_checkbox' : 'none';
    
    // SECONDARY CHECK: Only check EMAIL BODY if PDF shows unchecked
    if (!isDotPassChecked && emailBody) {
      console.log('PDF shows unchecked, checking EMAIL BODY for DOT line items...');
      
      const normalizedEmailBody = emailBody.toLowerCase();
      
      // Look for DOT inspection as a line item in the email body
      // These patterns indicate actual DOT service work
      const dotInEmailBody = 
        /\*\*dot\s+inspection/i.test(normalizedEmailBody) ||  // **DOT Inspection
        /dot\s+inspection\s+only/i.test(normalizedEmailBody) || // DOT Inspection Only
        /performed\s+dot\s+inspection/i.test(normalizedEmailBody) || // Performed DOT Inspection
        /\bdot\s+inspection.*?\$\d+/i.test(normalizedEmailBody); // DOT inspection with price
      
      if (dotInEmailBody) {
        isDotInspection = true;
        detectionMethod = 'email_body_line_item';
        console.log('FOUND DOT line item in email body');
      } else {
        console.log('No DOT line items found in email body');
      }
    }
    
    console.log('FINAL RESULT:', isDotInspection ? 'IS DOT' : 'NOT DOT');
    console.log('Detection method:', detectionMethod);

    // Return result
    return NextResponse.json({
      success: true,
      isDotInspection,
      detectionMethod,
      debug: {
        pdfHasCheckedBox: isDotPassChecked,
        emailBodyProvided: !!emailBody,
        emailBodyLength: emailBody ? emailBody.length : 0
      }
    });

  } catch (error: unknown) {
    console.error('Unexpected error in DOT check:', error);
    return NextResponse.json(
      { 
        success: false, 
        error: 'Internal server error',
        details: error instanceof Error ? error.message : 'Unknown error'
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
    expects: 'multipart/form-data with file (PDF) and emailBody (string)',
    timestamp: new Date().toISOString()
  });
}