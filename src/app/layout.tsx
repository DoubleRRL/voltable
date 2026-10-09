import type { Metadata } from "next";
import { Geist, Inter } from "next/font/google";
import { MotionConfig } from "framer-motion";

import { themeScript } from "@/components/chat/ThemeToggle";

import "./globals.css";
import "react-isokit/styles.css";
import "@/components/iso/iso.css";

// Geist is the sans the shadcn theme tokens resolve against.
// Inter is loaded with its optical-size axis so the weight animations the
// Fluid Functionalism components use (400 → 550 on hover and selection) hold
// their width instead of reflowing the label beside them.
const geist = Geist({ subsets: ["latin"], variable: "--font-sans" });
const inter = Inter({
  subsets: ["latin"],
  axes: ["opsz"],
  variable: "--font-inter",
  display: "swap",
});

export const metadata: Metadata = {
  title: "ESR Assistant",
  description: "Electrical Service Requirements",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className={geist.variable} suppressHydrationWarning>
      <head>
        {/* Applied before first paint so a dark-mode planner never sees a
            white flash. Kept inline and tiny on purpose. */}
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
      </head>
      <body className={inter.variable}>
        {/* reducedMotion="user" makes every framer-motion animation in the app
            honour the OS setting: transforms and layout drop, opacity and
            colour fades stay, because those carry meaning. */}
        <MotionConfig reducedMotion="user">{children}</MotionConfig>
      </body>
    </html>
  );
}
