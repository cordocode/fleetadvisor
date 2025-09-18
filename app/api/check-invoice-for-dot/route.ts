import { NextResponse } from 'next/server';
import pdf from 'pdf-parse';

export async function POST(request: Request) {
  try {
    // Get the PDF from form data
    const formData = await request.formData();
    const file = formData.get('file') as File;
    
    if (!file) {
      return NextResponse.json(
        { success: false, error: 'No file provided' },
        { status: 400 }
      );
    }

    // Convert file to buffer
    const bytes = await file.arrayBuffer();
    const buffer = Buffer.from(bytes);
    
    // Extract text from PDF
    const data = await pdf(buffer);
    const text = data.text;
    
    // Normalize text for robust matching
    const normalizedText = text
      .toLowerCase()
      .replace(/\s+/g, ' ')  // Replace multiple spaces with single space
      .replace(/[^\x20-\x7E]/g, '')  // Remove non-ASCII
      .trim();
    
    // Search for DOT PASS pattern (flexible spacing around colon)
    const dotPassPattern = /dot\s+pass\s*:\s*checked/;
    const isDotInspection = dotPassPattern.test(normalizedText);
    
    console.log('DOT Check - Found pattern:', isDotInspection);
    console.log('Sample text:', normalizedText.substring(0, 500));
    
    return NextResponse.json({
      success: true,
      isDotInspection,
      textLength: normalizedText.length
    });
    
  } catch (error) {
    console.error('PDF parsing error:', error);
    return NextResponse.json(
      { success: false, error: 'Failed to parse PDF' },
      { status: 500 }
    );
  }
}