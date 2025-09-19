import { NextRequest, NextResponse } from 'next/server';
import { PDFDocument } from 'pdf-lib';
import sharp from 'sharp';

export async function POST(request: NextRequest) {
  console.log('=== PDF Merge API Called ===');
  
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
      const fileName = file.name.toLowerCase();
      const bytes = await file.arrayBuffer();
      console.log(`Processing ${fileName} - Size: ${(bytes.byteLength / 1024 / 1024).toFixed(2)}MB`);
      
      try {
        if (fileName.endsWith('.pdf')) {
          // Handle PDF as before
          const pdf = await PDFDocument.load(bytes);
          const pages = await mergedPdf.copyPages(pdf, pdf.getPageIndices());
          pages.forEach(page => mergedPdf.addPage(page));
          
        } else if (fileName.match(/\.(jpg|jpeg|png)$/)) {
          // Smart compression for images
          let processedImageBuffer: Uint8Array;
          
          // Only compress if over 500KB
          if (bytes.byteLength > 500000) {
            console.log(`Compressing ${fileName} from ${(bytes.byteLength / 1024 / 1024).toFixed(2)}MB`);
            
            const compressedBuffer = await sharp(Buffer.from(bytes))
              .resize(2400, null, {
                withoutEnlargement: true,
                fit: 'inside'
              })
              .jpeg({ 
                quality: 85,
                mozjpeg: true
              })
              .toBuffer();
              
            processedImageBuffer = new Uint8Array(compressedBuffer);
            console.log(`Compressed to ${(processedImageBuffer.length / 1024 / 1024).toFixed(2)}MB`);
          } else {
            processedImageBuffer = new Uint8Array(bytes);
          }
          
          // Embed in PDF
          const image = await mergedPdf.embedJpg(processedImageBuffer);
          const page = mergedPdf.addPage();
          
          // Scale to fit page
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
    
    console.log(`Final PDF size: ${(buffer.length / 1024 / 1024).toFixed(2)}MB`);
    
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

export async function GET() {
  return NextResponse.json({ 
    status: 'healthy',
    endpoint: '/api/merge-pdfs'
  });
}