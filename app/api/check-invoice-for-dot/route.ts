import { NextResponse } from 'next/server';

export async function POST(request: Request) {
  try {
    // Dynamically import pdf-parse
    const pdf = (await import('pdf-parse')).default;

    const formData = await request.formData();

    // Debug: log all field names
    const keys = [...formData.keys()];
    console.log("FormData keys received:", keys);

    // Try to grab 'file' field
    const file = formData.get('file') as File | null;

    if (!file) {
      console.error("No file found under 'file'. Available keys:", keys);
      return NextResponse.json(
        { success: false, error: 'No file provided', availableKeys: keys },
        { status: 400 }
      );
    }

    // Convert to buffer
    const bytes = await file.arrayBuffer();
    const buffer = Buffer.from(bytes);

    // Debug file info (no any)
    console.log("File received:", {
      name: file.name,
      size: buffer.length,
      type: file.type,
    });

    // Parse PDF
    const data = await pdf(buffer);
    const text = data.text;

    const normalizedText = text
      .toLowerCase()
      .replace(/\s+/g, ' ')
      .replace(/[^\x20-\x7E]/g, '')
      .trim();

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
