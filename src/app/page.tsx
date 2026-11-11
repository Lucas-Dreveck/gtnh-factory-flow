import { FactoryPlannerApp } from "@/components/FactoryPlannerApp";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export default function Home() {
  return (
    <>
      <FactoryPlannerApp />
      {/* The one paragraph a JS-less visitor (or crawler) gets. Renders
          nothing at all when the app itself is going to. */}
      <noscript>
        <h1>GTNH Planner</h1>
        <p>
          A free factory planner and recipe calculator for GregTech: New
          Horizons. Draw production chains on an interactive flowchart with
          full recipe data for GTNH 2.9, balance machine ratios,
          compute power and throughput, and share plans with the community.
          The planner needs JavaScript to run.
        </p>
      </noscript>
    </>
  );
}
