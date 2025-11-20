import { google } from 'googleapis';
import { createClient } from '@supabase/supabase-js';
import { NextResponse } from 'next/server';

// Initialize Supabase client with service role key
const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

export async function GET() {
  try {
    // Use the SHEETS service account that already works
    if (!process.env.GOOGLE_SERVICE_ACCOUNT_SHEETS) {
      throw new Error('GOOGLE_SERVICE_ACCOUNT_SHEETS environment variable not set');
    }
    
    const serviceAccount = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_SHEETS);
    
    const auth = new google.auth.GoogleAuth({
      credentials: serviceAccount,
      scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
    });

    const sheets = google.sheets({ version: 'v4', auth });
    
    // Fetch data from CUSTOMER AI CODE sheet using the new env variable
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId: process.env.CUSTOMER_SHEET_ID,
      range: 'Sheet1!A:B', // Assumes Company Name in column A, Code in column B
    });

    const rows = response.data.values;
    
    if (!rows || rows.length === 0) {
      return NextResponse.json({ message: 'No data found in sheet' });
    }

    // Skip header row and process companies
    const companies = rows.slice(1).map(row => ({
      name: row[0]?.trim(),
      code: row[1]?.trim()
    })).filter(company => company.name && company.code);

    // Upsert companies to Supabase
    const { error } = await supabase
      .from('companies')
      .upsert(companies, { 
        onConflict: 'code',
        ignoreDuplicates: false 
      });

    if (error) {
      console.error('Supabase error:', error);
      return NextResponse.json(
        { error: `Supabase error: ${error.message}` },
        { status: 500 }
      );
    }

    return NextResponse.json({ 
      message: 'Sync successful', 
      companiesProcessed: companies.length 
    });

  } catch (error) {
    console.error('Sync error details:', error);

    let message = 'Failed to sync companies';
    if (error instanceof Error) {
      message = error.message;
    }

    return NextResponse.json({ error: message }, { status: 500 });
  }
}