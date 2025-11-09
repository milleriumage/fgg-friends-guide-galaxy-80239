// @ts-nocheck
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import Stripe from "https://esm.sh/stripe@14.21.0";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const stripe = new Stripe(Deno.env.get('STRIPE_SECRET_KEY') || '', {
      apiVersion: '2023-10-16',
    });

    const supabase = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_ANON_KEY') ?? ''
    );

    // Fallback maps when DB rows are missing
    const CREDIT_PACKAGE_MAP: Record<string, { credits: number; price: number; bonus?: number }> = {
      'prod_SyYasByos1peGR': { credits: 200, price: 2.0 },
      'prod_SyYeStqRDuWGFF': { credits: 500, price: 5.0 },
      'prod_SyYfzJ1fjz9zb9': { credits: 1000, price: 10.0 },
      'prod_SyYmVrUetdiIBY': { credits: 2500, price: 25.0 },
      'prod_SyYg54VfiOr7LQ': { credits: 5000, price: 50.0 },
      'prod_SyYhva8A2beAw6': { credits: 10000, price: 100.0 },
      'prod_SyYehlUkfzq9Qn': { credits: 100, price: 1.0 },
    };

    const PLAN_MAP: Record<string, { plan_id: string; credits: number; price: number; currency: string }> = {
      'prod_SyYChoQJbIb1ye': { plan_id: 'plan_free', credits: 0, price: 0, currency: 'usd' },
      'prod_SyYK31lYwaraZW': { plan_id: 'plan_basic', credits: 1000, price: 9, currency: 'usd' },
      'prod_SyYMs3lMIhORSP': { plan_id: 'plan_pro', credits: 2000, price: 15, currency: 'usd' },
      'prod_SyYVIP': { plan_id: 'plan_vip', credits: 4000, price: 25, currency: 'usd' },
    };

    // Map to support frontends that send only packageId (pkg1, pkg2, ...)
    const PACKAGE_ID_MAP: Record<string, { stripe_product_id: string; credits: number; price: number; bonus?: number }> = {
      'pkg1': { stripe_product_id: 'prod_SyYasByos1peGR', credits: 200, price: 2.0 },
      'pkg2': { stripe_product_id: 'prod_SyYeStqRDuWGFF', credits: 500, price: 5.0 },
      'pkg3': { stripe_product_id: 'prod_SyYfzJ1fjz9zb9', credits: 1000, price: 10.0 },
      'pkg4': { stripe_product_id: 'prod_SyYmVrUetdiIBY', credits: 2500, price: 25.0 },
      'pkg5': { stripe_product_id: 'prod_SyYg54VfiOr7LQ', credits: 5000, price: 50.0 },
      'pkg6': { stripe_product_id: 'prod_SyYhva8A2beAw6', credits: 10000, price: 100.0 },
    };

    // Get authenticated user
    const authHeader = req.headers.get('Authorization');
    if (!authHeader) {
      throw new Error('No authorization header');
    }

    const { data: { user }, error: userError } = await supabase.auth.getUser(
      authHeader.replace('Bearer ', '')
    );

    if (userError || !user) {
      throw new Error('Unauthorized');
    }

    const { type, packageId, planId, stripeProductId } = await req.json();

    console.log(`Creating Stripe checkout for user ${user.id}, type: ${type}, packageId: ${packageId}, planId: ${planId}, stripeProductId: ${stripeProductId}`);

    let sessionParams: Stripe.Checkout.SessionCreateParams;

    if (type === 'credit_package') {
      // Get credit package details - try by stripe_product_id first, then by id
      let pkg, pkgError;
      
      if (stripeProductId) {
        const result = await supabase
          .from('credit_packages')
          .select('*')
          .eq('stripe_product_id', stripeProductId)
          .maybeSingle();
        pkg = result.data;
        pkgError = result.error;
      }
      
      // Fallback to ID if stripe_product_id not provided or not found
      if (!pkg && packageId) {
        const result = await supabase
          .from('credit_packages')
          .select('*')
          .eq('id', packageId)
          .maybeSingle();
        pkg = result.data;
        pkgError = result.error;
      }

      const fallback = stripeProductId ? CREDIT_PACKAGE_MAP[stripeProductId] : undefined;
      const idFallback = packageId ? PACKAGE_ID_MAP[packageId] : undefined;
      const productId = pkg?.stripe_product_id || stripeProductId || idFallback?.stripe_product_id || null;
      const finalCredits = pkg?.credits ?? fallback?.credits ?? idFallback?.credits;
      const bonus = pkg?.bonus ?? fallback?.bonus ?? idFallback?.bonus ?? 0;
      const finalAmountCents = typeof pkg?.price === 'number' ? Math.round(pkg.price * 100)
        : (fallback?.price ? Math.round(fallback.price * 100)
        : (idFallback?.price ? Math.round(idFallback.price * 100) : undefined));

      if (!productId && finalAmountCents === undefined) {
        console.error('Package not found. Debug:', { packageId, stripeProductId });
        throw new Error('Credit package not found');
      }

      // Try to use an existing one-time price on Stripe for the product
      let priceId: string | undefined;
      if (productId) {
        const list = await stripe.prices.list({ product: productId, active: true, type: 'one_time' });
        priceId = list.data[0]?.id;
        if (!priceId && finalAmountCents !== undefined) {
          const created = await stripe.prices.create({
            product: productId,
            unit_amount: finalAmountCents,
            currency: 'usd',
          });
          priceId = created.id;
        }
      }

      const lineItem: Stripe.Checkout.SessionCreateParams.LineItem = priceId
        ? { price: priceId, quantity: 1 }
        : {
            price_data: {
              currency: 'usd',
              product_data: {
                name: `${finalCredits ?? 'Credits'} Credits`,
                description: bonus > 0 ? `Includes ${bonus} bonus credits!` : undefined,
              },
              unit_amount: finalAmountCents ?? 0,
            },
            quantity: 1,
          };

      sessionParams = {
        payment_method_types: ['card'],
        line_items: [ lineItem ],
        mode: 'payment',
        success_url: `${req.headers.get('origin') || 'http://localhost:8080'}/?payment=success`,
        cancel_url: `${req.headers.get('origin') || 'http://localhost:8080'}/?payment=cancelled`,
        metadata: {
          user_id: user.id,
          credits: (((finalCredits ?? 0) + (bonus || 0))).toString(),
          type: 'credit_purchase',
        },
      };

    } else if (type === 'subscription') {
      // Get subscription plan details - try by stripe_product_id first, then by id
      let plan, planError;
      
      if (stripeProductId) {
        const result = await supabase
          .from('subscription_plans')
          .select('*')
          .eq('stripe_product_id', stripeProductId)
          .maybeSingle();
        plan = result.data;
        planError = result.error;
      }
      
      // Fallback to ID if stripe_product_id not provided or not found
      if (!plan && planId) {
        const result = await supabase
          .from('subscription_plans')
          .select('*')
          .eq('id', planId)
          .maybeSingle();
        plan = result.data;
        planError = result.error;
      }

      // Build from DB or fallback map
      const productId = plan?.stripe_product_id || stripeProductId || null;
      const fb = productId ? PLAN_MAP[productId] : undefined;
      const finalPlanId = planId || fb?.plan_id || 'unknown_plan';
      const credits = plan?.credits ?? fb?.credits ?? 0;
      const currency = (plan?.currency || fb?.currency || 'usd').toLowerCase();
      const amountCents = typeof plan?.price === 'number'
        ? Math.round(plan.price * 100)
        : (fb ? Math.round(fb.price * 100) : undefined);

      if (!productId) {
        console.error('Plan missing product id; no DB row and no fallback');
        throw new Error('Subscription plan not found');
      }

      // Get or create Stripe recurring monthly price for this product
      const prices = await stripe.prices.list({ product: productId, active: true, type: 'recurring' });
      let priceId = prices.data.find(p => p.recurring?.interval === 'month')?.id;

      if (!priceId) {
        if (amountCents === undefined) {
          console.error('Cannot create price: amount unknown');
          throw new Error('Subscription plan not found');
        }
        const price = await stripe.prices.create({
          product: productId,
          unit_amount: amountCents,
          currency,
          recurring: { interval: 'month' },
        });
        priceId = price.id;
      }

      sessionParams = {
        payment_method_types: ['card'],
        line_items: [ { price: priceId, quantity: 1 } ],
        mode: 'subscription',
        success_url: `${req.headers.get('origin') || 'http://localhost:8080'}/?subscription=success`,
        cancel_url: `${req.headers.get('origin') || 'http://localhost:8080'}/?subscription=cancelled`,
        metadata: {
          user_id: user.id,
          plan_id: finalPlanId,
          credits: credits.toString(),
          type: 'subscription',
        },
        subscription_data: {
          metadata: {
            user_id: user.id,
            plan_id: finalPlanId,
            credits: credits.toString(),
            type: 'subscription',
          }
        }
      };
    } else {
      throw new Error('Invalid type');
    }

    const session = await stripe.checkout.sessions.create(sessionParams);

    console.log(`Stripe session created: ${session.id}`);

    return new Response(
      JSON.stringify({ sessionId: session.id, url: session.url }),
      {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      }
    );

  } catch (error) {
    console.error('Error creating Stripe checkout:', error);
    return new Response(
      JSON.stringify({ error: error.message }),
      { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});
