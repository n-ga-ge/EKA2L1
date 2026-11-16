# Browser frontend (Emscripten). Mirrors the Android frontend's shape: plain C++
# that owns the emulator state, a graphics thread and an OS thread, driven from
# the page through the control API instead of JNI.
add_executable(eka2l1_web
        include/web/persist.h
        include/web/state.h
        src/main.cpp
        src/persist.cpp
        src/state.cpp
        src/thread.cpp
        src/ui.cpp)

target_include_directories(eka2l1_web PRIVATE include)

target_link_libraries(eka2l1_web PRIVATE
        control_native
        common
        config
        cpu
        drivers
        lunasvg
        epoc
        epockern
        epocpkg
        epocservs
        sqlite3
        yaml-cpp)

if (ENABLE_SCRIPTING)
    target_link_libraries(eka2l1_web PRIVATE -Wl,--whole-archive $<TARGET_FILE:scripting> -Wl,--no-whole-archive)
    add_dependencies(eka2l1_web scripting)
endif()

# Patch DLLs are prebuilt Symbian binaries copied into bin/patch by these targets.
add_dependencies(eka2l1_web
        audiooutputrouting
        avkonfep
        ecam
        scdv
        mediaclientaudio
        mediaclientaudiostream
        mediaclientvideo
        vibractrl
        backlightctrl
        postingsurfacefactory
        goommonitor
        ssl
        commdb)

set_target_properties(eka2l1_web PROPERTIES
        RUNTIME_OUTPUT_DIRECTORY "${CMAKE_BINARY_DIR}/bin")

# Files the emulator reads from its working directory. They are staged into one
# folder and preloaded into the in-memory filesystem at /eka2l1.
set(WEB_ASSETS_DIR "${CMAKE_BINARY_DIR}/web-assets")
add_custom_target(eka2l1_web_assets
        COMMAND ${CMAKE_COMMAND} -E make_directory "${WEB_ASSETS_DIR}/resources/upscale"
        COMMAND ${CMAKE_COMMAND} -E make_directory "${WEB_ASSETS_DIR}/compat"
        COMMAND ${CMAKE_COMMAND} -E make_directory "${WEB_ASSETS_DIR}/patch"
        COMMAND ${CMAKE_COMMAND} -E copy_directory "${CMAKE_BINARY_DIR}/bin/patch/" "${WEB_ASSETS_DIR}/patch"
        COMMAND ${CMAKE_COMMAND} -E copy_directory "${PROJECT_SOURCE_DIR}/src/emu/drivers/resources/gles/" "${WEB_ASSETS_DIR}/resources"
        COMMAND ${CMAKE_COMMAND} -E copy_directory "${PROJECT_SOURCE_DIR}/src/emu/drivers/resources/upscale/" "${WEB_ASSETS_DIR}/resources/upscale"
        COMMAND ${CMAKE_COMMAND} -E copy_directory "${PROJECT_SOURCE_DIR}/miscs/compat/" "${WEB_ASSETS_DIR}/compat"
        COMMAND ${CMAKE_COMMAND} -E copy_if_different "${PROJECT_SOURCE_DIR}/src/emu/drivers/resources/defaultbank.hsb" "${WEB_ASSETS_DIR}/resources"
        COMMAND ${CMAKE_COMMAND} -E copy_if_different "${PROJECT_SOURCE_DIR}/src/emu/drivers/resources/defaultbank.sf2" "${WEB_ASSETS_DIR}/resources")
add_dependencies(eka2l1_web_assets
        audiooutputrouting avkonfep ecam scdv mediaclientaudio mediaclientaudiostream mediaclientvideo
        vibractrl backlightctrl postingsurfacefactory goommonitor ssl commdb)
add_dependencies(eka2l1_web eka2l1_web_assets)

# The page itself: static files served next to the generated module.
add_custom_command(TARGET eka2l1_web POST_BUILD
        COMMAND ${CMAKE_COMMAND} -E copy_directory "${CMAKE_CURRENT_SOURCE_DIR}/shell" "${CMAKE_BINARY_DIR}/bin")

# The whole emulator runs in a worker (PROXY_TO_PTHREAD) so its blocking loops
# never stall the page; the canvas is handed to the graphics thread as an
# OffscreenCanvas. WASMFS keeps file I/O on the calling thread instead of
# proxying every call to the page. Memory may grow: guest chunks are committed
# on demand.
target_link_options(eka2l1_web PRIVATE
        -sPROXY_TO_PTHREAD=1
        -sOFFSCREENCANVAS_SUPPORT=1
        -sMIN_WEBGL_VERSION=2
        -sMAX_WEBGL_VERSION=2
        -sWASMFS=1
        -sALLOW_MEMORY_GROWTH=1
        -sINITIAL_MEMORY=268435456
        -sMAXIMUM_MEMORY=2147483648
        -sPTHREAD_POOL_SIZE=12
        -sSTACK_SIZE=2097152
        -sDEFAULT_PTHREAD_STACK_SIZE=2097152
        -sEXIT_RUNTIME=0
        -sMODULARIZE=1
        -sEXPORT_NAME=createEka2l1
        -sENVIRONMENT=web,worker
        "-sEXPORTED_FUNCTIONS=_main,_malloc,_free"
        "-sEXPORTED_RUNTIME_METHODS=ccall,cwrap,UTF8ToString,stringToUTF8,lengthBytesUTF8,wasmMemory"
        "SHELL:--preload-file ${WEB_ASSETS_DIR}@/eka2l1")
