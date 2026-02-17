#include <my_lib.hpp>
#include <cmath>

double
distance(double x0, double y0, double x1, double y1) {
    return std::sqrt(std::pow(x1 - x0, 2) + std::pow(y1 - y0, 2));
}
