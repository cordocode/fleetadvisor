import { NextRequest, NextResponse } from 'next/server';
import { PDFDocument } from 'pdf-lib';

export async function POST(request: NextRequest) {
  console.log('=== PDF Merge API Called ===');
  console.log('Time:', new Date().toISOString());
  
  try {
    // Parse the incoming form data
    const formData = await request.formData();
    const files = formData.getAll('files') as File[];
    
    if (!files || files.length === 0) {
      console.log('ERROR: No files provided');
      return NextResponse.json(
        { 
          success: false, 
          error: 'No files provided',
          debug: 'Files field missing from form data'
        },
        { status: 400 }
      );
    }

    console.log(`Received ${files.length} files to merge`);

    // Create a new PDF document
    const mergedPdf = await PDFDocument.create();

    // Process each PDF
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      console.log(`Processing file ${i + 1}:`, {
        name: file.name,
        size: file.size,
        type: file.type
      });

      try {
        // Convert file to array buffer
        const bytes = await file.arrayBuffer();
        
        // Load the PDF
        const pdf = await PDFDocument.load(bytes);
        
        // Copy all pages from this PDF
        const pages = await mergedPdf.copyPages(pdf, pdf.getPageIndices());
        
        // Add pages to merged document
        pages.forEach((page) => {
          mergedPdf.addPage(page);
        });
        
        console.log(`Added ${pages.length} pages from ${file.name}`);
      } catch (fileError: unknown) {
        console.error(`Failed to process ${file.name}:`, fileError);
        // Continue with other files even if one fails
      }
    }

    // Save the merged PDF
    const mergedPdfBytes = await mergedPdf.save();
    
    // Convert Uint8Array to Buffer for NextResponse
    const buffer = Buffer.from(mergedPdfBytes);
    
    console.log(`Successfully merged ${files.length} PDFs`);
    console.log(`Final PDF size: ${buffer.length} bytes`);

    // Return the merged PDF as a response
    return new NextResponse(buffer, {
      status: 200,
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': 'attachment; filename="merged.pdf"'
      }
    });

  } catch (error: unknown) {
    console.error('Unexpected error in PDF merge:', error);
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

// Health check endpoint
export async function GET() {
  return NextResponse.json({ 
    status: 'healthy',
    endpoint: '/api/merge-pdfs',
    method: 'POST',
    expects: 'multipart/form-data with multiple files in "files" field',
    timestamp: new Date().toISOString()
  });
}