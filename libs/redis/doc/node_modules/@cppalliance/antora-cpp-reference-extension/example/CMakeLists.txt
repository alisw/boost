cmake_minimum_required(VERSION 3.10)
project(my_lib)

set(CMAKE_CXX_STANDARD 14)

file(GLOB SOURCES CONFIGURE_DEPENDS "src/*.cpp")
add_library(my_lib ${SOURCES})
target_include_directories(my_lib PRIVATE include)
