import { NextRequest, NextResponse } from 'next/server';
import { PDFDocument, rgb } from 'pdf-lib';
import sharp from 'sharp'; // npm install sharp

export async function POST(request: NextRequest) {
  console.log('=== File to PDF Merge API Called ===');
  
  try {
    const formData = await request.formData();
    const files = formData.getAll('files') as File[];
    
    if (!files || files.length === 0) {
      return NextResponse.json(
        { success: false, error: 'No files provided' },
        { status: 400 }
      );
    }

    console.log(`Received ${files.length} files to merge`);
    const mergedPdf = await PDFDocument.create();

    for (const file of files) {
      const bytes = await file.arrayBuffer();
      const fileName = file.name.toLowerCase();
      
      try {
        if (fileName.endsWith('.pdf')) {
          // Handle PDF
          const pdf = await PDFDocument.load(bytes);
          const pages = await mergedPdf.copyPages(pdf, pdf.getPageIndices());
          pages.forEach(page => mergedPdf.addPage(page));
          
        } else if (fileName.match(/\.(jpg|jpeg|png)$/)) {
          // Convert image to PDF page
          const pngBuffer = await sharp(Buffer.from(bytes))
            .png()
            .toBuffer();
          
          const image = await mergedPdf.embedPng(pngBuffer);
          const page = mergedPdf.addPage();
          
          // Scale image to fit page
          const { width, height } = image.scale(1);
          const pageWidth = page.getWidth();
          const pageHeight = page.getHeight();
          const scale = Math.min(pageWidth / width, pageHeight / height);
          
          page.drawImage(image, {
            x: (pageWidth - width * scale) / 2,
            y: (pageHeight - height * scale) / 2,
            width: width * scale,
            height: height * scale,
          });
        }
      } catch (err) {
        console.error(`Failed to process ${file.name}:`, err);
      }
    }

    const mergedPdfBytes = await mergedPdf.save();
    const buffer = Buffer.from(mergedPdfBytes);
    
    return new NextResponse(buffer, {
      status: 200,
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': 'attachment; filename="merged.pdf"'
      }
    });

  } catch (error: unknown) {
    console.error('Error:', error);
    return NextResponse.json(
      { success: false, error: 'Failed to merge files' },
      { status: 500 }
    );
  }
}