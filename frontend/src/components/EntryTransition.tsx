import { ViewTransition, type ComponentProps } from "react";

// Older engines still get the CSS entrance on the live page.
export default function EntryTransition(props: ComponentProps<typeof ViewTransition>) {
  return typeof document !== "undefined" && typeof document.startViewTransition === "function"
    ? <ViewTransition {...props} />
    : <>{props.children}</>;
}
