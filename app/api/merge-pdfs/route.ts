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
    
    console.log(`Processing ${fileUrls.length} file(s) for batch ${batchId}`);
    
    // Initialize Supabase client
    const supabase = createClient(supabaseUrl, supabaseKey);
    
    let finalPdfBytes: Uint8Array;
    let processMessage: string;
    
    // Check if we need to merge or just handle a single file
    if (fileUrls.length === 1) {
      // Single file - just download and rename
      console.log('Single file detected - skipping merge, just renaming');
      const response = await fetch(fileUrls[0]);
      const bytes = await response.arrayBuffer();
      const urlParts = fileUrls[0].split('/');
      const filename = urlParts[urlParts.length - 1].toLowerCase();
      
      if (filename.endsWith('.pdf')) {
        // It's already a PDF, just use it
        finalPdfBytes = new Uint8Array(bytes);
        processMessage = `Renamed single PDF to ${fileName}`;
      } else if (filename.match(/\.(jpg|jpeg|png)$/)) {
        // Single image - convert to PDF
        const mergedPdf = await PDFDocument.create();
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
        
        finalPdfBytes = await mergedPdf.save();
        processMessage = `Converted single image to PDF: ${fileName}`;
      } else {
        throw new Error(`Unsupported file type: ${filename}`);
      }
    } else {
      // Multiple files - merge them
      console.log(`Merging ${fileUrls.length} files`);
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
      finalPdfBytes = await mergedPdf.save();
      processMessage = `Merged ${fileUrls.length} files into ${fileName}`;
    }

    // Upload to production DOT bucket with duplicate handling
    let uploadSuccess = false;
    let skipReason = '';
    
    try {
      // First check if file exists
      const { data: existingFile } = await supabase.storage
        .from('DOT')
        .list('', {
          search: fileName
        });
      
      if (existingFile && existingFile.length > 0) {
        // File exists - skip upload but don't crash
        console.log(`File ${fileName} already exists in DOT bucket - skipping upload`);
        skipReason = 'File already exists';
        uploadSuccess = true; // Mark as "success" to continue with cleanup
      } else {
        // File doesn't exist - proceed with upload
        const { error: uploadError } = await supabase.storage
          .from('DOT')
          .upload(fileName, finalPdfBytes, {
            contentType: 'application/pdf',
            upsert: false // Don't overwrite if it exists (extra safety)
          });

        if (uploadError) {
          // Check if it's a duplicate error
          if (uploadError.message?.includes('already exists') || 
              uploadError.message?.includes('duplicate')) {
            console.log(`Duplicate file detected during upload: ${fileName}`);
            skipReason = 'Duplicate file';
            uploadSuccess = true; // Still cleanup temp files
          } else {
            // Some other error - throw it
            throw uploadError;
          }
        } else {
          uploadSuccess = true;
          console.log(`Successfully uploaded ${fileName}`);
        }
      }
    } catch (uploadError) {
      console.error('Upload error:', uploadError);
      // Continue to cleanup even if upload failed
      uploadSuccess = false;
    }

    // Clean up temp files regardless of upload success
    try {
      const tempFiles = fileUrls.map((url: string) => {
        const parts = url.split('/DOT-temp/')[1];
        return parts;
      });

      console.log(`Cleaning up ${tempFiles.length} temp file(s)`);
      const { error: cleanupError } = await supabase.storage
        .from('DOT-temp')
        .remove(tempFiles);
      
      if (cleanupError) {
        console.error('Cleanup error (non-fatal):', cleanupError);
      } else {
        console.log('Temp files cleaned up successfully');
      }
    } catch (cleanupError) {
      // Log but don't fail the whole operation
      console.error('Error during temp cleanup (non-fatal):', cleanupError);
    }

    // Return appropriate response
    if (skipReason) {
      return NextResponse.json({ 
        success: true, 
        fileName: fileName,
        batchId: batchId,
        message: processMessage,
        skipped: true,
        skipReason: skipReason,
        tempFilesCleaned: true
      });
    } else if (uploadSuccess) {
      return NextResponse.json({ 
        success: true, 
        fileName: fileName,
        batchId: batchId,
        message: processMessage,
        skipped: false,
        tempFilesCleaned: true
      });
    } else {
      return NextResponse.json({ 
        success: false, 
        fileName: fileName,
        batchId: batchId,
        message: 'Upload failed but temp files were cleaned',
        tempFilesCleaned: true
      });
    }

  } catch (error) {
    console.error('Critical error:', error);
    
    // Even in case of critical error, try to cleanup temp files
    try {
      const body = await request.json() as RequestBody;
      const { fileUrls, supabaseUrl, supabaseKey } = body;
      const supabase = createClient(supabaseUrl, supabaseKey);
      
      const tempFiles = fileUrls.map((url: string) => {
        const parts = url.split('/DOT-temp/')[1];
        return parts;
      });
      
      await supabase.storage.from('DOT-temp').remove(tempFiles);
      console.log('Emergency cleanup completed');
    } catch (cleanupError) {
      console.error('Emergency cleanup failed:', cleanupError);
    }
    
    return NextResponse.json(
      { success: false, error: String(error) },
      { status: 500 }
    );
  }
}