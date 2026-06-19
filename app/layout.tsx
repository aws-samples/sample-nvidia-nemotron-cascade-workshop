import type { Metadata } from "next";
import Nav from "./components/nav";
import "./globals.css";

export const metadata: Metadata = {
  title: "Nemotron Cascade Workshop",
  description: "Two-tier LLM inference on Amazon Bedrock with Nemotron and Claude",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body className="min-h-screen antialiased font-[family-name:var(--font-jakarta)]">
        <Nav />
        {children}
      </body>
    </html>
  );
}
