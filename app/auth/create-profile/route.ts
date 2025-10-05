import { createClient } from '@supabase/supabase-js';
import { NextResponse } from 'next/server';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

export async function POST(request: Request) {
  try {
    const { userId, companyId } = await request.json();

    // Check if this is the admin company
    const { data: company } = await supabase
      .from('companies')
      .select('name')
      .eq('id', companyId)
      .single();

    // Check if user should be admin (company name is exactly 'fleet-advisor-ai-admin')
    const isAdmin = company?.name === 'fleet-advisor-ai-admin';

    console.log('Creating profile for company:', company?.name, 'isAdmin:', isAdmin);

    // Create profile linking user to company with admin flag
    const { error } = await supabase
      .from('profiles')
      .insert([
        {
          user_id: userId,
          company_id: companyId,
          is_admin: isAdmin
        },
      ]);

    if (error) throw error;

    return NextResponse.json({ success: true, isAdmin });
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error occurred';
    return NextResponse.json(
      { error: errorMessage },
      { status: 500 }
    );
  }
}