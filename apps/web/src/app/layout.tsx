import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "MomentumScan",
  description:
    "Descriptive momentum detection for NSE options — analytical tool, not investment advice.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        {children}
        <footer>
          Analytical tool. Displays observed market data patterns only. Not
          investment advice.
        </footer>
      </body>
    </html>
  );
}
