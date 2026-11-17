# Browser frontend (Emscripten). Mirrors the Android frontend's shape: plain C++
# that owns the emulator state, a graphics thread and an OS thread, driven from
# the page through the control API instead of JNI.
add_executable(eka2l1_web
        include/web/diag.h
        include/web/net.h
        include/web/persist.h
        include/web/state.h
        src/diag.cpp
        src/diag_audio.cpp
        src/diag_exits.cpp
        src/diag_graphics.cpp
        src/diag_speed.cpp
        src/main.cpp
        src/net.cpp
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
        COMMAND ${CMAKE_COMMAND} -E copy_directory "${CMAKE_CURRENT_SOURCE_DIR}/shaders/" "${WEB_ASSETS_DIR}/resources/upscale"
        COMMAND ${CMAKE_COMMAND} -E copy_directory "${PROJECT_SOURCE_DIR}/miscs/compat/" "${WEB_ASSETS_DIR}/compat"
        COMMAND ${CMAKE_COMMAND} -E copy_if_different "${PROJECT_SOURCE_DIR}/src/emu/drivers/resources/defaultbank.hsb" "${WEB_ASSETS_DIR}/resources"
        COMMAND ${CMAKE_COMMAND} -E copy_if_different "${PROJECT_SOURCE_DIR}/src/emu/drivers/resources/defaultbank.sf2" "${WEB_ASSETS_DIR}/resources")
add_dependencies(eka2l1_web_assets
        audiooutputrouting avkonfep ecam scdv mediaclientaudio mediaclientaudiostream mediaclientvideo
        vibractrl backlightctrl postingsurfacefactory goommonitor ssl commdb)
add_dependencies(eka2l1_web eka2l1_web_assets)

# The page itself: static files served next to the generated module. Copied on
# every build, since editing them does not relink the module.
add_custom_target(eka2l1_web_shell
        COMMAND ${CMAKE_COMMAND} -E copy_directory "${CMAKE_CURRENT_SOURCE_DIR}/shell" "${CMAKE_BINARY_DIR}/bin")
add_dependencies(eka2l1_web eka2l1_web_shell)

# The whole emulator runs in a worker (PROXY_TO_PTHREAD) so its blocking loops
# never stall the page; the canvas is handed to the graphics thread as an
# OffscreenCanvas. WASMFS keeps file I/O on the calling thread instead of
# proxying every call to the page. Memory starts small and grows; the ceiling is
# kept at 1 GB because some mobile browsers reserve a shared memory's maximum
# up front and refuse larger ones. A Shadowkey session peaks under 500 MB of
# heap, about 200 MB of it in use.
target_link_options(eka2l1_web PRIVATE
        -sPROXY_TO_PTHREAD=1
        -sOFFSCREENCANVAS_SUPPORT=1
        -sMIN_WEBGL_VERSION=2
        -sMAX_WEBGL_VERSION=2
        -sWASMFS=1
        -sALLOW_MEMORY_GROWTH=1
        -sINITIAL_MEMORY=167772160
        -sMAXIMUM_MEMORY=1073741824
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
