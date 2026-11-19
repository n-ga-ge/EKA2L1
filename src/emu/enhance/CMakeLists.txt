# Debug routes for looking into a running guest (code segments, memory,
# registers, hooks, a program-counter profile), the capture machine that
# turns a game's calls into its software rasteriser into triangle lists, and
# the layer that draws those triangles with the graphics driver.
add_library(enhance
    include/enhance/enhance.h
    include/enhance/expr.h
    src/capture.cpp
    src/engine.h
    src/expr.cpp
    src/keyfill.cpp
    src/layer.cpp
    src/layer.h
    src/routes.cpp)

target_include_directories(enhance PUBLIC include)
target_link_libraries(enhance PUBLIC control PRIVATE common config cpu drivers epoc epockern epocservs xxHash)
set_target_properties(enhance PROPERTIES POSITION_INDEPENDENT_CODE ON)
