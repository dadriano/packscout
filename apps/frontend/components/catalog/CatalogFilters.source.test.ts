import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const source = readFileSync(new URL("./CatalogFilters.client.tsx", import.meta.url), "utf8");

test("the reset control becomes a clear-filters X action for selected filters", () => {
  assert.match(source, /function ClearFiltersIcon/);
  assert.match(source, /d="M4 4l8 8M12 4 4 12"/);
  assert.doesNotMatch(source, /M3\.2 4\.3h9\.6/);
  assert.match(source, /hasChosenFilters\(draft\)/);
  assert.match(source, /Clear selected filters/);
  assert.match(source, /hasFilters \? <ClearFiltersIcon \/> : <ResetIcon \/>/);
});

test("both range handles use the shared segmented price ladder", () => {
  assert.equal(source.match(/max=\{PRICE_FILTER_SLIDER_MAX_INDEX\}/g)?.length, 2);
  assert.equal(source.match(/min=\{PRICE_FILTER_SLIDER_MIN_INDEX\}/g)?.length, 2);
  assert.equal(source.match(/priceSliderValueFromIndex\(/g)?.length, 3);
  assert.equal(source.match(/value=\{priceSliderIndexForBound\(/g)?.length, 2);
  assert.match(source, /const thumb = closerPriceThumb\(/);
  assert.match(source, /updateSliderThumb\(thumb, event\.clientX, track\)/);
  assert.match(source, /onPointerMove=\{handleSliderPointerMove\}/);
  assert.match(source, /onPointerUp=\{handleSliderPointerEnd\}/);
  assert.match(source, /onKeyDown=\{\(event\) => handleSliderKeyDown\("min", event\)\}/);
  assert.match(source, /onKeyDown=\{\(event\) => handleSliderKeyDown\("max", event\)\}/);
});

test("track selection focuses the chosen thumb and invalid fields recover from visible bounds", () => {
  assert.match(source, /const minimumRangeRef = useRef<HTMLInputElement>\(null\)/);
  assert.match(source, /const maximumRangeRef = useRef<HTMLInputElement>\(null\)/);
  assert.match(
    source,
    /focusPriceSliderThumb\(thumb, minimumRangeRef\.current, maximumRangeRef\.current\)/,
  );
  assert.match(source, /ref=\{minimumRangeRef\}/);
  assert.match(source, /ref=\{maximumRangeRef\}/);
  assert.match(source, /priceSliderIndexForBound\(currentValue, thumb\)/);
  assert.match(source, /priceSliderIndexForBound\(minimum, "min"\)/);
  assert.match(source, /priceSliderIndexForBound\(maximum, "max"\)/);
});

test("numeric fields and Apply behavior remain intact", () => {
  assert.equal(source.match(/type="number"/g)?.length, 2);
  assert.match(source, /onClick=\{\(\) => onApply\(draft\)\}/);
  assert.match(source, /disabled=\{!valid \|\| !changed \|\| pending\}/);
  assert.match(source, /onClick=\{onReset\}/);
  assert.match(source, /Enter a valid \$1–\$12,000 range\./);
});
