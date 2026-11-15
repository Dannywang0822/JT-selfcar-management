import { dispatch } from "@/server/api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function handle(request: Request, context: { params: Promise<{ slug: string[] }> }) {
  const { slug } = await context.params;
  return dispatch(request, slug);
}

export { handle as GET, handle as POST };
