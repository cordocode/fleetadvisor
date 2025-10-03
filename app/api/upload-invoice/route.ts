import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

export async function POST(request: NextRequest) {
  console.log('=== Invoice Upload API Called ===');
  
  try {
    const formData = await request.formData();
    const file = formData.get('file') as File | null;
    const fileName = formData.get('fileName') as string | null;
    
    if (!file) {
      console.log('ERROR: No file provided in request');
      return NextResponse.json(
        { success: false, error: 'No file provided' },
        { status: 400 }
      );
    }

    if (!fileName) {
      console.log('ERROR: No fileName provided in request');
      return NextResponse.json(
        { success: false, error: 'No fileName provided' },
        { status: 400 }
      );
    }

    console.log('File received:', file.name);
    console.log('Target filename:', fileName);

    // Convert File to ArrayBuffer then to Uint8Array
    const bytes = await file.arrayBuffer();
    const fileBytes = new Uint8Array(bytes);

    // Check if file already exists
    const { data: existingFile } = await supabase.storage
      .from('Invoice')
      .list('', {
        search: fileName
      });
    
    if (existingFile && existingFile.length > 0) {
      console.log(`File ${fileName} already exists in Invoice bucket - skipping upload`);
      return NextResponse.json({
        success: true,
        fileName: fileName,
        message: 'File already exists',
        skipped: true
      });
    }

    // Upload to Invoice bucket
    const { error: uploadError } = await supabase.storage
      .from('Invoice')
      .upload(fileName, fileBytes, {
        contentType: 'application/pdf',
        upsert: false
      });

    if (uploadError) {
      if (uploadError.message?.includes('already exists') || 
          uploadError.message?.includes('duplicate')) {
        console.log(`Duplicate file detected during upload: ${fileName}`);
        return NextResponse.json({
          success: true,
          fileName: fileName,
          message: 'Duplicate file',
          skipped: true
        });
      }
      
      throw uploadError;
    }

    console.log(`Successfully uploaded ${fileName} to Invoice bucket`);

    return NextResponse.json({ 
      success: true, 
      fileName: fileName,
      message: 'Invoice uploaded successfully',
      skipped: false
    });

  } catch (error) {
    console.error('Invoice upload error:', error);
    return NextResponse.json(
      { success: false, error: String(error) },
      { status: 500 }
    );
  }
}