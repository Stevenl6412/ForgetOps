import Link from "next/link";

export default async function ExportDownloadPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return (
    <main
      style={{
        maxWidth: 720,
        margin: "0 auto",
        padding: "4rem 1.5rem",
        fontFamily: "var(--font-geist-sans), sans-serif",
      }}
    >
      <p style={{ color: "#64748b", fontSize: 14 }}>ForgetOps privacy portal</p>
      <h1 style={{ marginTop: 8 }}>Download your export</h1>
      <p style={{ color: "#475569", lineHeight: 1.6 }}>
        This download is encrypted for the browser session. The control plane
        never receives the archive plaintext or your decryption key.
      </p>
      <section
        aria-label="Export request"
        style={{
          marginTop: 24,
          padding: 20,
          border: "1px solid #e2e8f0",
          borderRadius: 12,
          background: "#f8fafc",
        }}
      >
        <p style={{ fontSize: 14, color: "#64748b" }}>Request</p>
        <code>{id}</code>
        <p style={{ marginTop: 16, color: "#475569" }}>
          Re-authenticate to create a one-time browser key envelope.
        </p>
        <button
          type="button"
          disabled
          style={{
            marginTop: 8,
            padding: "0.7rem 1rem",
            border: 0,
            borderRadius: 8,
            background: "#94a3b8",
            color: "white",
            cursor: "not-allowed",
          }}
        >
          Re-authentication required
        </button>
      </section>
      <Link
        href={`/portal/requests/${id}`}
        style={{
          display: "inline-block",
          marginTop: 24,
          color: "#0f766e",
          textDecoration: "underline",
        }}
      >
        Back to request status
      </Link>
    </main>
  );
}
