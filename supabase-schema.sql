-- GoWell fresh database schema. Run only in a NEW/approved Supabase project.
create extension if not exists pgcrypto;

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text,
  role text not null default 'customer' check (role in ('customer','admin')),
  created_at timestamptz not null default now()
);
create table if not exists public.wallets (
  user_id uuid primary key references auth.users(id) on delete cascade,
  balance_paise bigint not null default 0 check (balance_paise >= 0),
  updated_at timestamptz not null default now()
);
create table if not exists public.wallet_ledger (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  amount_paise bigint not null check (amount_paise <> 0),
  entry_type text not null check (entry_type in ('credit','debit','adjustment')),
  reason text not null,
  reference_id text unique,
  created_at timestamptz not null default now()
);
create table if not exists public.payment_orders (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  amount_paise bigint not null check (amount_paise > 0),
  currency text not null default 'INR' check (currency = 'INR'),
  razorpay_order_id text not null unique,
  razorpay_payment_id text unique,
  status text not null default 'created' check (status in ('created','paid')),
  created_at timestamptz not null default now(),
  credited_at timestamptz
);

alter table public.profiles enable row level security;
alter table public.wallets enable row level security;
alter table public.wallet_ledger enable row level security;
alter table public.payment_orders enable row level security;

drop policy if exists "Users can read own profile" on public.profiles;
create policy "Users can read own profile" on public.profiles for select to authenticated using (auth.uid() = id);
drop policy if exists "Users can read own wallet" on public.wallets;
create policy "Users can read own wallet" on public.wallets for select to authenticated using (auth.uid() = user_id);
drop policy if exists "Users can read own ledger" on public.wallet_ledger;
create policy "Users can read own ledger" on public.wallet_ledger for select to authenticated using (auth.uid() = user_id);
drop policy if exists "Users can read own payment orders" on public.payment_orders;
create policy "Users can read own payment orders" on public.payment_orders for select to authenticated using (auth.uid() = user_id);

-- Create a profile and empty wallet for each new Supabase Auth user.
create or replace function public.gowell_create_user_rows()
returns trigger language plpgsql security definer set search_path = public, auth
as $$
begin
  insert into public.profiles(id,email) values(new.id,new.email)
    on conflict (id) do update set email=excluded.email;
  insert into public.wallets(user_id,balance_paise) values(new.id,0)
    on conflict (user_id) do nothing;
  return new;
end; $$;
drop trigger if exists gowell_auth_user_created on auth.users;
create trigger gowell_auth_user_created after insert on auth.users
for each row execute procedure public.gowell_create_user_rows();

-- Atomically marks the order paid, credits wallet and writes one ledger row.
-- Only the backend service-role should call this function; never expose service role to the browser.
create or replace function public.gowell_credit_verified_payment(
  p_razorpay_order_id text,
  p_razorpay_payment_id text,
  p_amount_paise bigint
) returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_order public.payment_orders%rowtype;
  v_balance bigint;
begin
  select * into v_order from public.payment_orders
    where razorpay_order_id = p_razorpay_order_id for update;
  if not found then raise exception 'payment order not found'; end if;
  if v_order.amount_paise <> p_amount_paise then raise exception 'payment amount mismatch'; end if;
  if v_order.status = 'paid' then
    if v_order.razorpay_payment_id = p_razorpay_payment_id then
      select balance_paise into v_balance from public.wallets where user_id=v_order.user_id;
      return jsonb_build_object('already_credited', true, 'balance_paise', coalesce(v_balance,0));
    end if;
    raise exception 'order already credited with a different payment';
  end if;
  if exists (select 1 from public.wallet_ledger where reference_id = p_razorpay_payment_id) then
    raise exception 'payment id already used';
  end if;
  insert into public.wallets(user_id,balance_paise) values(v_order.user_id,0)
    on conflict (user_id) do nothing;
  update public.wallets set balance_paise=balance_paise+p_amount_paise, updated_at=now()
    where user_id=v_order.user_id returning balance_paise into v_balance;
  insert into public.wallet_ledger(user_id,amount_paise,entry_type,reason,reference_id)
    values(v_order.user_id,p_amount_paise,'credit','Verified Razorpay recharge',p_razorpay_payment_id);
  update public.payment_orders set status='paid',razorpay_payment_id=p_razorpay_payment_id,credited_at=now()
    where id=v_order.id;
  return jsonb_build_object('already_credited', false, 'balance_paise', v_balance);
end; $$;
revoke all on function public.gowell_credit_verified_payment(text,text,bigint) from public, anon, authenticated;
grant execute on function public.gowell_credit_verified_payment(text,text,bigint) to service_role;

-- No customer insert/update policy exists for wallets or ledger. Admin payout features are not included here.
