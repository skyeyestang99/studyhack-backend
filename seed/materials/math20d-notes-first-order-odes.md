# First-Order ODEs: Separable and Linear Equations (MATH 20D Notes)

## What is a first-order ODE?
A first-order ordinary differential equation relates an unknown function y(x) to its first derivative: dy/dx = f(x, y). A solution is a function y(x) that satisfies this relation on some interval. The general solution contains one arbitrary constant; an initial condition y(x0) = y0 pins it down to a particular solution.

## Separable equations
An equation is separable if it can be written as dy/dx = g(x) h(y). We solve by separating variables and integrating both sides:
  (1/h(y)) dy = g(x) dx  =>  ∫ (1/h(y)) dy = ∫ g(x) dx + C.

Example: dy/dx = x y. Separate: (1/y) dy = x dx. Integrate: ln|y| = x^2/2 + C, so y = A e^{x^2/2}, where A = ±e^C is an arbitrary nonzero constant (and y = 0 is a singular solution lost when dividing by y).

Watch for equilibrium solutions where h(y) = 0; dividing by h(y) can drop them, so check them separately.

## Linear first-order equations
A linear first-order ODE has the form dy/dx + p(x) y = q(x). Solve using an integrating factor μ(x) = e^{∫ p(x) dx}. Multiplying through makes the left side an exact derivative:
  d/dx [ μ(x) y ] = μ(x) q(x),
so y = (1/μ(x)) ( ∫ μ(x) q(x) dx + C ).

Example: dy/dx + 2y = e^{-x}. Here p = 2, so μ = e^{2x}. Then d/dx(e^{2x} y) = e^{2x} e^{-x} = e^{x}. Integrate: e^{2x} y = e^{x} + C, giving y = e^{-x} + C e^{-2x}.

## Existence and uniqueness
If f(x, y) and ∂f/∂y are continuous near (x0, y0), then the initial value problem dy/dx = f(x,y), y(x0)=y0 has a unique solution on some interval around x0 (Picard–Lindelöf). This guarantees solution curves do not cross where the hypotheses hold.

## Modeling note
First-order linear ODEs model exponential growth/decay, mixing/tank problems, and RC circuits. The steady state corresponds to the particular solution; the C e^{-∫p} term is the transient that decays when p > 0.
