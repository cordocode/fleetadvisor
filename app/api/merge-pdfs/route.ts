import { NextRequest, NextResponse } from 'next/server';
import { PDFDocument } from 'pdf-lib';
import { createClient } from '@supabase/supabase-js';

interface RequestBody {
  batchId: string;
  fileUrls: string[];
  fileName: string;
  supabaseUrl: string;
  supabaseKey: string;
}

export async function POST(request: NextRequest) {
  console.log('=== PDF Merge API Called ===');
  
  try {
    const body = await request.json() as RequestBody;
    const { batchId, fileUrls, fileName, supabaseUrl, supabaseKey } = body;
    
    // Initialize Supabase client
    const supabase = createClient(supabaseUrl, supabaseKey);
    
    const mergedPdf = await PDFDocument.create();

    // Download each file from URLs
    for (const url of fileUrls) {
      const response = await fetch(url);
      const bytes = await response.arrayBuffer();
      const urlParts = url.split('/');
      const filename = urlParts[urlParts.length - 1].toLowerCase();
      
      if (filename.endsWith('.pdf')) {
        const pdf = await PDFDocument.load(bytes);
        const pages = await mergedPdf.copyPages(pdf, pdf.getPageIndices());
        pages.forEach(page => mergedPdf.addPage(page));
        
      } else if (filename.match(/\.(jpg|jpeg|png)$/)) {
        // Embed image directly without optimization
        const imageBytes = new Uint8Array(bytes);
        
        let image;
        if (filename.endsWith('.png')) {
          image = await mergedPdf.embedPng(imageBytes);
        } else {
          image = await mergedPdf.embedJpg(imageBytes);
        }
        
        const page = mergedPdf.addPage();
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
    }

    // Save merged PDF
    const mergedPdfBytes = await mergedPdf.save();
    
    // Upload to production DOT bucket
    const { error: uploadError } = await supabase.storage
      .from('DOT')
      .upload(fileName, mergedPdfBytes, {
        contentType: 'application/pdf'
      });

    if (uploadError) throw uploadError;

    // Clean up temp files
    const tempFiles = fileUrls.map((url: string) => {
      const parts = url.split('/DOT-temp/')[1];
      return parts;
    });

    await supabase.storage.from('DOT-temp').remove(tempFiles);

    return NextResponse.json({ 
      success: true, 
      fileName: fileName,
      batchId: batchId,
      message: `Merged ${fileUrls.length} files into ${fileName}`
    });

  } catch (error) {
    console.error('Error:', error);
    return NextResponse.json(
      { success: false, error: String(error) },
      { status: 500 }
    );
  }
}