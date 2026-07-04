# Divide and Conquer and the Master Theorem (CSE 101 Notes)

## The divide-and-conquer paradigm
A divide-and-conquer algorithm solves a problem by (1) dividing it into smaller subproblems of the same type, (2) conquering the subproblems by solving them recursively, and (3) combining their solutions into a solution for the original problem. The running time is captured by a recurrence relation.

## Merge sort
Merge sort splits an array of n elements into two halves, sorts each recursively, and merges the two sorted halves in linear time. Its recurrence is T(n) = 2 T(n/2) + Θ(n), which solves to Θ(n log n). Merge sort is stable and has worst-case Θ(n log n), unlike quicksort whose worst case is Θ(n^2).

## The Master Theorem
For recurrences of the form T(n) = a T(n/b) + f(n), where a ≥ 1 and b > 1, compare f(n) with n^{log_b a}:
- Case 1: if f(n) = O(n^{log_b a - ε}) for some ε > 0, then T(n) = Θ(n^{log_b a}).
- Case 2: if f(n) = Θ(n^{log_b a}), then T(n) = Θ(n^{log_b a} log n).
- Case 3: if f(n) = Ω(n^{log_b a + ε}) and the regularity condition a f(n/b) ≤ c f(n) holds for c < 1, then T(n) = Θ(f(n)).

## Worked examples
- Merge sort: a=2, b=2, f(n)=Θ(n). Here n^{log_2 2} = n, so Case 2 gives Θ(n log n).
- Binary search: a=1, b=2, f(n)=Θ(1). n^{log_2 1} = n^0 = 1, Case 2 gives Θ(log n).
- Naive recursive matrix work T(n) = 8 T(n/2) + Θ(n^2): log_2 8 = 3, and n^2 = O(n^{3-ε}), so Case 1 gives Θ(n^3). Strassen's algorithm reduces a from 8 to 7, giving Θ(n^{log_2 7}) ≈ Θ(n^{2.81}).

## When the Master Theorem does not apply
The theorem requires subproblems of equal size b and fits the three cases only. Recurrences like T(n) = T(n/3) + T(2n/3) + n (unequal splits) need the recursion-tree or Akra–Bazzi method instead.
