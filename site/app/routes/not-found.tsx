import { data, Link } from "react-router";

export function loader() {
  return data(null, { status: 404 });
}

export function meta() {
  return [{ title: "Page not found | Delta" }, { name: "robots", content: "noindex, nofollow" }];
}

export default function NotFound() {
  return (
    <main className="mx-auto min-h-screen max-w-3xl px-6 py-24">
      <p className="mb-3 font-mono text-xs uppercase tracking-[0.16em] text-muted-foreground">
        Delta
      </p>
      <h1 className="text-5xl font-semibold tracking-[-0.04em]">404</h1>
      <p className="mt-5 text-lg text-muted-foreground">The requested page could not be found.</p>
      <Link
        className="mt-8 inline-flex rounded-full border px-5 py-2.5 text-sm font-medium transition-colors hover:bg-muted"
        to="/"
      >
        Return home
      </Link>
    </main>
  );
}
