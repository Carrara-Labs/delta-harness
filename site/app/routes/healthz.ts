export function loader() {
  return Response.json(
    { status: "ok", service: "delta-website" },
    {
      headers: {
        "cache-control": "no-store",
      },
    },
  );
}
