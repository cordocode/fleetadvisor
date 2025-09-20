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

    // Normalize the extracted text for robust matching
    const normalizedText = pdfData.text
      .toLowerCase()
      .replace(/\s+/g, ' ')           // Collapse all whitespace to single spaces
      .replace(/[^\x20-\x7E]/g, '')   // Remove non-ASCII characters (OCR artifacts)
      .trim();
    
    console.log('Normalized text sample (first 500 chars):');
    console.log(normalizedText.substring(0, 500));

    // PRIMARY CHECK: Look for "DOT PASS: checked" pattern
    const dotPassPattern = /dot\s+pass\s*:\s*checked/;
    const primaryCheckPassed = dotPassPattern.test(normalizedText);
    
    console.log('PRIMARY CHECK (DOT PASS: checked):', primaryCheckPassed ? 'FOUND' : 'NOT FOUND');
    
    let isDotInspection = primaryCheckPassed;
    let detectionMethod = primaryCheckPassed ? 'primary_checkbox' : 'none';
    let matchedPattern = '';
    
    // SECONDARY CHECK: Only run if primary check failed
    if (!primaryCheckPassed) {
      console.log('Primary check failed, running secondary DOT service detection...');
      
      // Patterns to look for DOT-related service items
      // Using word boundaries (\b) to avoid matching DOT inside other words
      const dotServicePatterns = [
        /\bdot\s+inspection\b/i,                    // "DOT Inspection"
        /\bdot\s+inspection\s+only\b/i,            // "DOT Inspection Only"
        /\bdot\s+service\b/i,                      // "DOT Service"
        /\bperformed\s+dot\s+inspection\b/i,       // "Performed DOT Inspection"
        /\bdot\s+annual\b/i,                        // "DOT Annual"
        /\bannual\s+dot\b/i,                        // "Annual DOT"
        /\bdot\s+compliance\b/i,                    // "DOT Compliance"
        /\bdot\s+safety\s+inspection\b/i,          // "DOT Safety Inspection"
        /\bfederal\s+dot\b/i,                      // "Federal DOT"
        /\bdot\s+pm\b/i,                           // "DOT PM" (Preventive Maintenance)
        /\bdot\s+-\s+/i,                           // "DOT -" followed by description
      ];
      
      // Also check for DOT as a line item with quantity/price
      // Pattern: DOT followed by description and then price indicators
      const dotLineItemPattern = /\bdot\s+[^.]*\d+\.\d{2}/i;  // DOT followed by text and a price (e.g., 145.00)
      
      // Check all patterns
      for (const pattern of dotServicePatterns) {
        if (pattern.test(normalizedText)) {
          isDotInspection = true;
          detectionMethod = 'secondary_service_item';
          const match = normalizedText.match(pattern);
          matchedPattern = match ? match[0] : '';
          console.log(`SECONDARY CHECK MATCHED: Pattern "${pattern}" found "${matchedPattern}"`);
          break;
        }
      }
      
      // Check for DOT line item pattern if not found yet
      if (!isDotInspection && dotLineItemPattern.test(normalizedText)) {
        isDotInspection = true;
        detectionMethod = 'secondary_line_item';
        const match = normalizedText.match(dotLineItemPattern);
        matchedPattern = match ? match[0].substring(0, 50) : ''; // Limit to 50 chars
        console.log(`SECONDARY CHECK MATCHED: DOT line item found "${matchedPattern}"`);
      }
      
      // Additional context check: Look for DOT with surrounding invoice context
      if (!isDotInspection) {
        // Check if DOT appears near typical invoice keywords
        const contextPattern = /(?:service|labor|inspection|performed|completed|charge|description|qty|rate).*?\bdot\b.*?(?:\$|\d+\.\d{2})/i;
        if (contextPattern.test(normalizedText)) {
          isDotInspection = true;
          detectionMethod = 'secondary_context';
          const match = normalizedText.match(contextPattern);
          matchedPattern = match ? match[0].substring(0, 50) : '';
          console.log(`SECONDARY CHECK MATCHED: DOT found in invoice context "${matchedPattern}"`);
        }
      }
    }
    
    // Additional debug info
    const debugInfo = {
      containsDot: normalizedText.includes('dot'),
      containsPass: normalizedText.includes('pass'),
      containsChecked: normalizedText.includes('checked'),
      containsInspection: normalizedText.includes('inspection'),
      textLength: normalizedText.length,
      detectionMethod: detectionMethod,
      matchedPattern: matchedPattern
    };
    
    console.log('Final result:', isDotInspection ? 'IS DOT INSPECTION' : 'NOT DOT INSPECTION');
    console.log('Detection method:', detectionMethod);
    console.log('Debug info:', debugInfo);

    // Return result
    return NextResponse.json({
      success: true,
      isDotInspection,
      detectionMethod,
      debug: {
        ...debugInfo,
        sampleText: normalizedText.substring(0, 200) // First 200 chars for debugging
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
    expects: 'multipart/form-data with file field',
    timestamp: new Date().toISOString()
  });
}