import { google } from 'googleapis';
import { createClient } from '@supabase/supabase-js';
import { NextResponse } from 'next/server';
import path from 'path';

// Initialize Supabase client with service role key
const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

export async function GET() {
  try {
    let auth;

    // Check if we have the service account as an environment variable (Vercel)
    if (process.env.GOOGLE_SERVICE_ACCOUNT) {
      console.log('Using Google service account from environment variable');
      const serviceAccount = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT);

      auth = new google.auth.GoogleAuth({
        credentials: serviceAccount,
        scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
      });
    } else {
      console.log('Using Google service account from file (local development)');
      const keyPath = path.join(process.cwd(), 'private', 'google-service-account.json');

      const fs = await import('fs');
      if (!fs.existsSync(keyPath)) {
        throw new Error('Google service account file not found and GOOGLE_SERVICE_ACCOUNT env var not set');
      }

      auth = new google.auth.GoogleAuth({
        keyFile: keyPath,
        scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
      });
    }

    const sheets = google.sheets({ version: 'v4', auth });

    // Fetch data from Google Sheets
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId: process.env.GOOGLE_SHEET_ID,
      range: 'Sheet1!A:B',
    });

    const rows = response.data.values;

    if (!rows || rows.length === 0) {
      throw new Error('No data found in Google Sheet');
    }

    const companies = rows
      .slice(1)
      .map(row => ({
        name: row[0]?.trim(),
        code: row[1]?.trim(),
      }))
      .filter(company => company.name && company.code);

    const { error } = await supabase
      .from('companies')
      .upsert(companies, {
        onConflict: 'code',
        ignoreDuplicates: false,
      });

    if (error) {
      throw new Error(`Supabase error: ${error.message}`);
    }

    return NextResponse.json({
      message: 'Sync successful',
      companiesProcessed: companies.length,
    });
  } catch (error: any) {
    console.error('Sync error:', error);

    // Expose more error detail in response
    return NextResponse.json(
      {
        error: error?.message || JSON.stringify(error) || 'Unknown error',
      },
      { status: 500 }
    );
  }
}
