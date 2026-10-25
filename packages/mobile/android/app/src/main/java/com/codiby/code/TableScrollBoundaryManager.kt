package com.codiby.code

import android.view.MotionEvent
import android.view.View
import android.view.ViewGroup
import com.facebook.react.uimanager.ThemedReactContext
import com.facebook.react.views.view.ReactViewGroup
import com.facebook.react.views.view.ReactViewManager

class TableScrollBoundaryManager : ReactViewManager() {
    override fun getName() = "CodibyTableScrollBoundary"
    override fun createViewInstance(context: ThemedReactContext): ReactViewGroup =
        TableScrollBoundary(context)
}

private class TableScrollBoundary(context: ThemedReactContext) : ReactViewGroup(context) {
    private val density = resources.displayMetrics.density
    private val direction = TableScrollDirection(6f * density, 20f * density)
    private var tracking = false

    private fun overflows(view: View): Boolean =
        view.canScrollHorizontally(-1) || view.canScrollHorizontally(1) ||
            (view is ViewGroup && (0 until view.childCount).any { overflows(view.getChildAt(it)) })

    override fun dispatchTouchEvent(event: MotionEvent): Boolean {
        when (event.actionMasked) {
            MotionEvent.ACTION_DOWN -> {
                tracking = overflows(this)
                direction.start(event.x, event.y)
                if (tracking) parent?.requestDisallowInterceptTouchEvent(true)
            }
            MotionEvent.ACTION_MOVE -> if (tracking) {
                val axis = direction.move(event.x, event.y)
                parent?.requestDisallowInterceptTouchEvent(axis != TableScrollDirection.Axis.VERTICAL)
            }
        }
        val handled = super.dispatchTouchEvent(event)
        if (event.actionMasked == MotionEvent.ACTION_UP || event.actionMasked == MotionEvent.ACTION_CANCEL) {
            tracking = false
            parent?.requestDisallowInterceptTouchEvent(false)
        }
        return handled
    }
}
