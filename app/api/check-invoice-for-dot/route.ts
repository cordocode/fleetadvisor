import { NextResponse } from 'next/server';
import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.mjs';

// Disable worker in serverless
pdfjsLib.GlobalWorkerOptions.workerSrc = '';

export async function POST(request: Request) {
  try {
    const formData = await request.formData();
    const file = formData.get('file') as File | null;

    if (!file) {
      return NextResponse.json(
        { success: false, error: 'No file provided' },
        { status: 400 }
      );
    }

    // Convert to buffer
    const bytes = await file.arrayBuffer();
    const buffer = new Uint8Array(bytes);

    // Load PDF
    const loadingTask = pdfjsLib.getDocument({ data: buffer });
    const pdf = await loadingTask.promise;

    // Extract plain text
    let text = '';
    for (let i = 1; i <= pdf.numPages; i++) {
      const page = await pdf.getPage(i);
      const content = await page.getTextContent();
      // content.items is an array of { str: string; ... }
      for (const item of content.items as Array<{ str: string }>) {
        text += item.str + ' ';
      }
    }

    // Normalize text
    const normalizedText = text
      .toLowerCase()
      .replace(/\s+/g, ' ')          // collapse whitespace
      .replace(/[^\x20-\x7E]/g, '')  // strip weird OCR chars
      .trim();

    // Pattern check
    const dotPassPattern = /dot\s+pass\s*:\s*checked/;
    const isDotInspection = dotPassPattern.test(normalizedText);

    console.log('DOT Check - Found pattern:', isDotInspection);
    console.log('Sample text:', normalizedText.substring(0, 500));

    return NextResponse.json({
      success: true,
      isDotInspection,
      textLength: normalizedText.length,
    });
  } catch (error) {
    console.error('PDF parsing error:', error);
    return NextResponse.json(
      { success: false, error: 'Failed to parse PDF', details: (error as Error).message },
      { status: 500 }
    );
  }
}
