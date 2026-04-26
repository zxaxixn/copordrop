# CopOrDrop Fair Price Algorithm

The tracker estimates a fair UAE retail price from Microless and Amazon.ae offers. PCPartPicker or `manualMsrp` is only an anchor used to penalize suspicious retailer prices.

## Inputs

For product `P`, collect retailer offers:

```text
offer_i = {
  price_i,
  source_i,
  title_i,
  seller_i,
  inStock_i,
  rating_i,
  reviewCount_i
}
```

Anchor price:

```text
A = manualMsrp if set, otherwise PCPartPicker_USD * 3.67 * 1.15
```

Last known tracked price:

```text
H = most recent priceHistory value
```

## Exact Match Filter

Each offer title is normalized into model tokens, capacity tokens, and tier words.
Compact GPU titles are split before matching, so `RTX5070Ti`, `RTX 5070 TI`, and `RTX 5070 Ti` become equivalent tokens.

Hard rejects:

```text
missing required model token
missing required tier word, e.g. RTX 5070 listing for RTX 5070 Ti product
wrong capacity, e.g. 1TB listing for 2TB product
wrong tier, e.g. RTX 4070 Ti when product is RTX 4070
system/bundle listing, e.g. full gaming PC result for a GPU product
invalid price
```

Title match score:

```text
M_i = 0.72 * tokenCoverage_i + 0.28 * modelCoverage_i
```

## Offer Weight

Every accepted offer gets a weight:

```text
W_i = S_i * M_i * R_i * T_i * A_i * H_i
```

Where:

```text
S_i = source trust
Microless = 1.00
Amazon.ae = 0.82

M_i = exact title/model match score
R_i = seller/review score
T_i = stock score
A_i = anchor sanity score
H_i = history sanity score
```

Anchor sanity:

```text
ratio_i = price_i / A

ratio < 0.50      => A_i = 0.12, scam-risk-too-cheap
0.50 to 0.65      => A_i = 0.38, below-anchor
0.65 to 1.35      => A_i = 1.00, normal
1.35 to 1.65      => A_i = 0.72, inflated
1.65 to 2.10      => A_i = 0.42, heavily-inflated
ratio > 2.10      => A_i = 0.16, extreme-inflation
```

History sanity:

```text
move_i = abs(price_i - H) / H

move <= 15%       => H_i = 1.00
15% to 30%        => H_i = 0.82
30% to 50%        => H_i = 0.58
move > 50%        => H_i = 0.32
```

## Robust Fair Price

The algorithm does not use a plain mean or plain median.

1. Compute the weighted median:

```text
m = weightedMedian(price_i, W_i)
```

2. Compute weighted median absolute deviation:

```text
MAD = weightedMedian(abs(price_i - m), W_i)
spread = max(0.10 * m, 1.4826 * MAD)
```

3. Build a robust clamp band:

```text
L = m - 1.35 * spread
U = m + 1.35 * spread
```

If anchor `A` exists:

```text
L = max(L, 0.55 * A)
U = min(U, 1.85 * A)
```

4. Winsorize each price into the band:

```text
adjusted_i = min(max(price_i, L), U)
```

5. Compute weighted fair market price:

```text
marketFair = sum(W_i * adjusted_i) / sum(W_i)
```

6. Blend lightly toward the anchor only when retailer evidence is weak:

```text
if acceptedOffers < 2 or sum(W_i) < 1.2:
  fair = 0.80 * marketFair + 0.20 * A
else:
  fair = marketFair
```

## Output

The tracker stores:

```text
price            = rounded fair price
fairPrice        = same fair price, explicit field
lowTrustedPrice  = weighted 20th percentile
highTrustedPrice = weighted 80th percentile
priceConfidence  = 0-100
priceStatus      = trusted | watch | manual_review | anchor_only
priceOffers      = scored offers used by the algorithm
```

Confidence:

```text
C = 0.18
  + 0.22 * min(acceptedOffers, 4) / 4
  + 0.18 * min(sourceCount, 2) / 2
  + 0.24 * min(sum(W_i) / 2.5, 1)
  + 0.18 * weightedAverage(M_i)
  - riskPenalty
  - anchorBlendPenalty
```

Status:

```text
C >= 70 and no risk flags => trusted
C >= 55                  => watch
otherwise                => manual_review
no retailer offers        => anchor_only if anchor exists
```

This makes cheap scam-looking listings and inflated listings mathematically visible as lower-weight offers instead of letting them dominate the final price.
