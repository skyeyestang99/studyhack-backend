# Practice Problems: Separable ODEs (MATH 20D)

These problems reinforce the separation-of-variables technique for first-order equations. Try each before reading the outline.

## Problem 1
Solve dy/dx = 3x^2 (1 + y^2).
Outline: separate as dy/(1 + y^2) = 3x^2 dx. Integrate: arctan(y) = x^3 + C. So y = tan(x^3 + C). The domain is restricted so the argument stays in (-π/2, π/2).

## Problem 2
Solve the initial value problem dy/dx = -x/y, y(0) = 3.
Outline: separate y dy = -x dx. Integrate: y^2/2 = -x^2/2 + C, i.e. x^2 + y^2 = K. Apply y(0)=3: K = 9. The solution is the circle x^2 + y^2 = 9, locally y = sqrt(9 - x^2). Note the solution only exists for |x| < 3.

## Problem 3 (mixing)
A tank holds 100 L of pure water. Brine with 2 g/L salt flows in at 5 L/min; the well-mixed solution flows out at 5 L/min. Let S(t) be grams of salt. Then dS/dt = (rate in) - (rate out) = 5·2 - 5·(S/100) = 10 - S/20.
Outline: this is linear, dS/dt + S/20 = 10. Integrating factor e^{t/20} gives S = 200 + C e^{-t/20}. With S(0)=0, C = -200, so S(t) = 200(1 - e^{-t/20}). The steady-state salt content is 200 g.

## Problem 4 (equilibria)
For dy/dx = y(1 - y), identify equilibrium solutions and their stability.
Outline: equilibria where y(1-y)=0 → y=0 and y=1. Linearizing, y=0 is unstable and y=1 is stable. Non-equilibrium solutions follow the logistic curve y = 1/(1 + A e^{-x}).

## Common mistakes
- Forgetting the equilibrium solution lost when dividing by h(y).
- Dropping the constant of integration, or adding it before exponentiating.
- Not checking the interval of validity implied by the initial condition.
