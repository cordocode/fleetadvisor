import { createClient } from '@supabase/supabase-js';
import { NextResponse } from 'next/server';

// Use service role to bypass RLS
const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

export async function POST(request: Request) {
  try {
    const { userId, companyId } = await request.json();

    // Create profile with service role (bypasses RLS)
    const { data, error } = await supabase
      .from('profiles')
      .insert({
        user_id: userId,
        company_id: companyId,
      });

    if (error) throw error;

    return NextResponse.json({ success: true });
  } catch (error: any) {
    return NextResponse.json(
      { error: error.message },
      { status: 500 }
    );
  }
}